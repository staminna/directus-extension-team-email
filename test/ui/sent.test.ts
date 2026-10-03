// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sent from '../../src/module/routes/Sent.vue';
import EmailList from '../../src/module/components/EmailList.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { resetRouter, router } from '../mocks/vue-router';
import { mockConfirm, settle, stubs } from './helpers';

function routeGets(list: any) {
    api.get.mockImplementation(async (url: string) => {
        if (url === '/users/me') return { data: { data: { id: 'me' } } };
        if (list instanceof Error) throw list;
        return list;
    });
}

async function mountSent() {
    const w = mount(Sent, { global: { stubs } });
    await settle();
    await flushPromises();
    return w;
}
const list = (w: any) => w.findComponent(EmailList).props();

describe('Sent', () => {
    beforeEach(() => { resetApi(); resetRouter(); });
    afterEach(() => vi.useRealTimers());

    it('loads the user\'s sent mail', async () => {
        routeGets({ data: { data: [{ id: 's1', thread_id: 't1' }] } });
        const w = await mountSent();
        expect(api.get).toHaveBeenCalledWith('/items/emails', expect.objectContaining({
            params: expect.objectContaining({ filter: { direction: { _eq: 'sent' }, owner: { _eq: 'me' } } }),
        }));
        expect(list(w).items).toHaveLength(1);
        expect(list(w).showTo).toBe(true);
        await w.find('.email-row').trigger('click');
        expect(router.push).toHaveBeenCalledWith({ name: 'email-thread', params: { id: 't1' } });
    });

    it('does not load without a user id', async () => {
        api.get.mockResolvedValue({ data: {} });
        const w = mount(Sent, { global: { stubs } });
        await flushPromises();
        api.get.mockClear();
        await (w.vm as any).$.setupState.load();
        expect(api.get).not.toHaveBeenCalled();
        w.unmount();
    });

    it('waits for the user id', async () => {
        vi.useFakeTimers();
        let resolveMe!: (v: any) => void;
        api.get.mockImplementation((url: string) => url === '/users/me'
            ? new Promise(r => { resolveMe = r; })
            : Promise.resolve({ data: {} }));
        const w = mount(Sent, { global: { stubs } });
        await vi.advanceTimersByTimeAsync(120);
        resolveMe({ data: { data: { id: 'me' } } });
        await vi.advanceTimersByTimeAsync(60);
        expect(list(w).items).toEqual([]);
        expect(list(w).loading).toBe(false);
    });

    it('shows load errors', async () => {
        routeGets(new Error('down'));
        let w = await mountSent();
        expect(w.find('.notice-danger').text()).toBe('down');
        routeGets({ toString: () => '' } as any);
        api.get.mockImplementation(async (url: string) => {
            if (url === '/users/me') return { data: { data: { id: 'me' } } };
            throw {};
        });
        w = await mountSent();
        expect(w.find('.notice-danger').text()).toBe('Could not load sent messages.');
    });

    it('deletes after confirmation', async () => {
        routeGets({ data: { data: [{ id: 's1' }, { id: 's2' }] } });
        const w = await mountSent();
        const confirm = mockConfirm();
        confirm.mockReturnValueOnce(false);
        await list(w).onDelete('s1');
        expect(api.delete).not.toHaveBeenCalled();

        confirm.mockReturnValue(true);
        api.delete.mockResolvedValueOnce({});
        await list(w).onDelete('s1');
        await flushPromises();
        expect(api.delete).toHaveBeenCalledWith('/email/sent/s1');
        expect(list(w).items.map((r: any) => r.id)).toEqual(['s2']);

        api.delete.mockRejectedValueOnce(new Error('denied'));
        await list(w).onDelete('s2');
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('denied');
        api.delete.mockRejectedValueOnce({});
        await list(w).onDelete('s2');
        await flushPromises();
        expect(w.find('.notice-danger').text()).toBe('Could not delete the message.');
    });
});
