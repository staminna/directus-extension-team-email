// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Inbox from '../../src/module/routes/Inbox.vue';
import EmailList from '../../src/module/components/EmailList.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { resetRouter, router } from '../mocks/vue-router';
import { httpError, mockConfirm, settle, stubs } from './helpers';

const rows = () => [
    { id: 'm1', thread_id: 't1', is_read: false, subject: 'One' },
    { id: 'm2', thread_id: 't2', is_read: true, subject: 'Two' },
];

/** /users/me → me, inbox list → given rows. */
function routeGets(list: any = { data: { data: rows() } }) {
    api.get.mockImplementation(async (url: string) => {
        if (url === '/users/me') return { data: { data: { id: 'me' } } };
        if (url === '/items/inbox_email') {
            if (list instanceof Error) throw list;
            return list;
        }
        throw new Error(`unexpected ${url}`);
    });
}

async function mountInbox() {
    const w = mount(Inbox, { global: { stubs } });
    await settle();
    await flushPromises();
    return w;
}

const list = (w: any) => w.findComponent(EmailList).props();

describe('Inbox', () => {
    beforeEach(() => {
        resetApi();
        resetRouter();
        api.post.mockResolvedValue({ data: { status: 'ok', stored: 0 } });
    });
    afterEach(() => vi.useRealTimers());

    it('loads the signed-in user\'s inbox and runs a background sync', async () => {
        routeGets();
        const w = await mountInbox();
        expect(api.get).toHaveBeenCalledWith('/items/inbox_email', expect.objectContaining({
            params: expect.objectContaining({ filter: { owner: { _eq: 'me' } }, sort: '-received_at', limit: 100 }),
        }));
        expect(list(w).items.map((r: any) => r.id)).toEqual(['m1', 'm2']);
        expect(list(w).loading).toBe(false);
        expect(api.post).toHaveBeenCalledWith('/email/imap/sync', null, { params: {} });
        // nothing new → no reload
        expect(api.get.mock.calls.filter(c => c[0] === '/items/inbox_email')).toHaveLength(1);
        expect(w.find('.inbox-sync-note').exists()).toBe(false);
    });

    it('does not load without a user id', async () => {
        api.get.mockResolvedValue({ data: {} });
        const w = mount(Inbox, { global: { stubs } });
        await flushPromises();
        api.get.mockClear();
        await (w.vm as any).$.setupState.load();
        expect(api.get).not.toHaveBeenCalled();
        w.unmount();
    });

    it('waits for the user id before loading', async () => {
        vi.useFakeTimers();
        let resolveMe!: (v: any) => void;
        api.get.mockImplementation((url: string) => url === '/users/me'
            ? new Promise(r => { resolveMe = r; })
            : Promise.resolve({ data: {} }));
        mount(Inbox, { global: { stubs } });
        await vi.advanceTimersByTimeAsync(120);
        expect(api.get).toHaveBeenCalledTimes(1);
        resolveMe({ data: { data: { id: 'me' } } });
        await vi.advanceTimersByTimeAsync(60);
        expect(api.get).toHaveBeenCalledWith('/items/inbox_email', expect.anything());
    });

    it('treats a missing data payload as empty', async () => {
        routeGets({ data: null });
        const w = await mountInbox();
        expect(list(w).items).toEqual([]);
    });

    it('shows a load error, with a default message', async () => {
        routeGets(new Error('boom'));
        let w = await mountInbox();
        expect(w.find('.notice-danger').text()).toBe('boom');
        routeGets(Object.assign(new Error(), { message: undefined }));
        w = await mountInbox();
        expect(w.find('.notice-danger').text()).toBe('Could not load the inbox.');
    });

    it('reloads after a background sync that stored mail', async () => {
        routeGets();
        api.post.mockResolvedValue({ data: { status: 'ok', stored: 2 } });
        const w = await mountInbox();
        expect(api.get.mock.calls.filter(c => c[0] === '/items/inbox_email')).toHaveLength(2);
        expect(w.find('.inbox-sync-note').exists()).toBe(false);
    });

    it('forced sync reports new messages or up to date', async () => {
        routeGets();
        const w = await mountInbox();
        api.post.mockResolvedValueOnce({ data: { status: 'ok', stored: 3 } });
        await w.find('.inbox-toolbar .v-button').trigger('click');
        await flushPromises();
        expect(api.post).toHaveBeenLastCalledWith('/email/imap/sync', null, { params: { force: 1 } });
        expect(w.find('.inbox-sync-note').text()).toBe('3 new message(s)');

        api.post.mockResolvedValueOnce({ data: { status: 'ok', stored: 0 } });
        await w.find('.inbox-toolbar .v-button').trigger('click');
        await flushPromises();
        expect(w.find('.inbox-sync-note').text()).toBe('Up to date');

        api.post.mockResolvedValueOnce({ data: { status: 'running' } });
        await w.find('.inbox-toolbar .v-button').trigger('click');
        await flushPromises();
        expect(w.find('.inbox-sync-note').exists()).toBe(false);
    });

    it('ignores a sync click while one is running', async () => {
        routeGets();
        let release!: (v: any) => void;
        api.post.mockImplementationOnce(() => new Promise(r => { release = r; }));
        const w = await mountInbox();
        const before = api.post.mock.calls.length;
        await (w.vm as any).$.setupState.syncMailbox(true);
        expect(api.post.mock.calls.length).toBe(before);
        release({ data: {} });
        await flushPromises();
    });

    it('sync errors: silent for 404/503, otherwise surfaced', async () => {
        routeGets();
        api.post.mockRejectedValueOnce(httpError(404));
        const w = await mountInbox();
        expect(w.find('.inbox-sync-note').exists()).toBe(false);

        const click = async (err: any) => {
            api.post.mockRejectedValueOnce(err);
            await w.find('.inbox-toolbar .v-button').trigger('click');
            await flushPromises();
            return w.find('.inbox-sync-note');
        };
        expect((await click(httpError(503))).exists()).toBe(false);
        expect((await click(httpError(500, { error: 'imap down' }))).text()).toBe('imap down');
        expect((await click(httpError(500, { message: 'msg' }))).text()).toBe('msg');
        expect((await click(new Error('net'))).text()).toBe('Mailbox sync failed');
    });

    it('opening a row marks it read and navigates to the thread', async () => {
        routeGets();
        const w = await mountInbox();
        api.post.mockResolvedValueOnce({});
        await w.findAll('.email-row')[0]!.trigger('click');
        await flushPromises();
        expect(api.post).toHaveBeenLastCalledWith('/email/inbox/m1/read');
        expect(router.push).toHaveBeenCalledWith({ name: 'email-thread', params: { id: 't1' } });
        expect(list(w).items[0].is_read).toBe(true);
    });

    it('toggles read state; unknown ids and failures are tolerated', async () => {
        routeGets();
        const w = await mountInbox();
        const { onToggleRead } = list(w);
        api.post.mockResolvedValueOnce({});
        await onToggleRead('m2', false);
        expect(api.post).toHaveBeenLastCalledWith('/email/inbox/m2/unread');
        expect(list(w).items[1].is_read).toBe(false);
        api.post.mockResolvedValueOnce({});
        await onToggleRead('zz', true);
        api.post.mockRejectedValueOnce(new Error('x'));
        await expect(onToggleRead('m1', true)).resolves.toBeUndefined();
        expect(list(w).items[0].is_read).toBe(false);
    });

    it('deletes after confirmation and reports failures', async () => {
        routeGets();
        const w = await mountInbox();
        const confirm = mockConfirm();
        const { onDelete } = list(w);

        confirm.mockReturnValueOnce(false);
        await onDelete('m1');
        expect(api.delete).not.toHaveBeenCalled();

        confirm.mockReturnValue(true);
        api.delete.mockResolvedValueOnce({});
        await onDelete('m1');
        await flushPromises();
        expect(api.delete).toHaveBeenCalledWith('/email/inbox/m1');
        expect(list(w).items.map((r: any) => r.id)).toEqual(['m2']);

        api.delete.mockRejectedValueOnce(httpError(403, { message: 'not yours' }));
        await onDelete('m2');
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('not yours');
        api.delete.mockRejectedValueOnce(new Error('net'));
        await onDelete('m2');
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('net');
        api.delete.mockRejectedValueOnce({});
        await onDelete('m2');
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('Could not delete the message.');
    });
});
