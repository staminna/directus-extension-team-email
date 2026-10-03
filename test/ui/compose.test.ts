// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Compose from '../../src/module/routes/Compose.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { resetRouter, router } from '../mocks/vue-router';
import { RichText, VUpload, httpError, stubs } from './helpers';

const USERS = [
    { id: 'u1', email: 'ann@x.test', first_name: 'Ann', last_name: 'Lee' },
    { id: 'u2', email: 'bob@x.test', first_name: 'Bob', last_name: null },
    { id: 'u3', email: 'cy@x.test' },
];

function gets(opts: { recipients?: any; users?: any; config?: any } = {}) {
    api.get.mockImplementation(async (url: string) => {
        const v = url === '/email/recipients' ? opts.recipients ?? { data: { data: USERS } }
            : url === '/users' ? opts.users ?? { data: { data: [] } }
            : url === '/email/config' ? opts.config ?? { data: { attachments_folder: 'fold', max_attachment_bytes: 2048 } }
            : new Error(url);
        if (v instanceof Error) throw v;
        return v;
    });
}

let w: ReturnType<typeof mount>;
async function mountCompose() {
    w = mount(Compose, { attachTo: document.body, global: { stubs } });
    await flushPromises();
    return w;
}
const s = () => (w.vm as any).$.setupState;
const inputs = () => w.findAll('input.v-input');
const options = () => w.findAll('.user-option');
const key = (el: any, k: string) => el.trigger('keydown', { key: k });
const sendBtn = () => w.findAll('.v-button').find(b => b.text() === 'Send')!;
const modeBtn = (label: string) => w.findAll('.v-button').find(b => b.text() === label)!;

describe('Compose', () => {
    beforeEach(() => { resetApi(); resetRouter(); });
    afterEach(() => { w?.unmount(); vi.useRealTimers(); });

    it('loads recipients and config on mount', async () => {
        gets();
        await mountCompose();
        expect(s().allUsers).toHaveLength(3);
        expect(w.findComponent(VUpload).props('folder')).toBe('fold');
        expect(s().maxAttachmentBytes).toBe(2048);
        expect(w.findComponent(RichText).props('toolbar')).toContain('customImage');
        expect(api.get).not.toHaveBeenCalledWith('/users', expect.anything());
    });

    it('falls back to /users when /email/recipients is empty or fails', async () => {
        gets({ recipients: { data: { data: [] } }, users: { data: { data: [{ id: 'a', email: 'a@x' }, { id: 'b', email: null }] } } });
        await mountCompose();
        expect(s().allUsers).toEqual([{ id: 'a', email: 'a@x' }]);
        w.unmount();

        gets({ recipients: new Error('403'), users: { data: {} } });
        await mountCompose();
        expect(s().allUsers).toEqual([]);
        expect(s().usersLoaded).toBe(true);
        // second call is a no-op once loaded
        api.get.mockClear();
        await s().loadInternalUsers();
        expect(api.get).not.toHaveBeenCalled();
        w.unmount();

        gets({ recipients: { data: null }, users: new Error('nope'), config: new Error('cfg') });
        await mountCompose();
        expect(w.find('.notice-warning').text()).toBe('Could not load the list of users.');
        expect(s().maxAttachmentBytes).toBe(26_214_400);
        expect(s().attachmentsFolder).toBeNull();
    });

    it('config without values keeps the defaults', async () => {
        gets({ config: { data: null } });
        await mountCompose();
        expect(s().attachmentsFolder).toBeNull();
        expect(s().maxAttachmentBytes).toBe(26_214_400);
    });

    it('internal mode: search, keyboard navigation, pick and remove users', async () => {
        gets();
        await mountCompose();
        const q = inputs()[0]!;
        await q.trigger('focus');
        expect(options().map(o => o.text())).toEqual(['Ann Lee <ann@x.test>', 'Bob <bob@x.test>', 'cy@x.test']);

        await key(q, 'ArrowDown');
        await key(q, 'ArrowDown');
        await key(q, 'ArrowDown');
        expect(s().activeIndex).toBe(0);
        await key(q, 'ArrowUp');
        expect(s().activeIndex).toBe(2);
        await options()[1]!.trigger('mousemove');
        expect(options()[1]!.classes()).toContain('active');
        await key(q, 'x'); // other keys ignored
        await key(q, 'Enter');
        expect(s().selectedUsers.map((u: any) => u.id)).toEqual(['u2']);
        expect(options().map(o => o.text())).not.toContain('Bob <bob@x.test>');

        await q.setValue('lee');
        expect(options().map(o => o.text())).toEqual(['Ann Lee <ann@x.test>']);
        await options()[0]!.trigger('mousedown');
        expect(s().selectedUsers.map((u: any) => u.id)).toEqual(['u2', 'u1']);
        expect(s().userQuery).toBe('');

        // picking an already selected user is a no-op
        s().pickUser(USERS[0]);
        expect(s().selectedUsers).toHaveLength(2);

        await w.findAll('.chip-x')[0]!.trigger('click');
        expect(s().selectedUsers.map((u: any) => u.id)).toEqual(['u1']);

        await key(q, 'Escape');
        expect(s().activeField).toBeNull();
        // no suggestions open → arrows do nothing
        await key(q, 'ArrowDown');
        expect(s().activeIndex).toBe(0);
        // applying with no field is ignored
        s().applySuggestion(USERS[2]);
        expect(s().selectedUsers).toHaveLength(1);
    });

    it('keeps the highlighted index inside a shrinking list', async () => {
        gets();
        await mountCompose();
        const q = inputs()[0]!;
        await q.trigger('focus');
        await key(q, 'ArrowUp'); // index 2
        await q.setValue('ann');
        await flushPromises();
        expect(s().activeIndex).toBe(0);
        await key(q, 'Tab');
        expect(s().selectedUsers.map((u: any) => u.id)).toEqual(['u1']);
    });

    it('external mode: token autocomplete in To and Cc skips already addressed people', async () => {
        gets();
        await mountCompose();
        await modeBtn('External').trigger('click');
        const [to, cc] = inputs();
        await to!.trigger('focus');
        expect(options()).toHaveLength(0); // empty token
        await to!.setValue('an');
        expect(options().map(o => o.text())).toEqual(['Ann Lee <ann@x.test>']);
        await key(to!, 'Enter');
        expect(s().to).toBe('ann@x.test, ');

        await cc!.trigger('focus');
        await cc!.setValue('x.test');
        // Ann is already in To
        expect(options().map(o => o.text())).toEqual(['Bob <bob@x.test>', 'cy@x.test']);
        await options()[0]!.trigger('mousemove');
        expect(s().activeIndex).toBe(0);
        await options()[1]!.trigger('mousemove');
        expect(s().activeIndex).toBe(1);
        await options()[1]!.trigger('mousedown');
        expect(s().cc).toBe('cy@x.test, ');

        await to!.trigger('focus');
        await to!.setValue('ann@x.test, b');
        expect(options().map(o => o.text())).toEqual(['Bob <bob@x.test>']);
        await options()[0]!.trigger('mousemove');
        await options()[0]!.trigger('mousedown');
        expect(s().to).toBe('ann@x.test, bob@x.test, ');

        await modeBtn('Internal').trigger('click');
        expect(s().mode).toBe('internal');
        expect(s().activeField).toBeNull();
    });

    it('clicking outside a picker closes the dropdown, inside keeps it', async () => {
        gets();
        await mountCompose();
        await inputs()[0]!.trigger('focus');
        inputs()[0]!.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(s().activeField).toBe('internal');
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(s().activeField).toBeNull();
        s().onDocPointerDown({ target: null });
        expect(s().activeField).toBeNull();
    });

    it('removes the document listener on unmount', async () => {
        gets();
        const remove = vi.spyOn(document, 'removeEventListener');
        await mountCompose();
        w.unmount();
        expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    });

    it('suggestions are empty without users', async () => {
        gets({ recipients: { data: { data: [] } } });
        await mountCompose();
        await inputs()[0]!.trigger('focus');
        expect(s().suggestions).toEqual([]);
    });

    it('attachments: add, dedupe, size total, limit and remove', async () => {
        gets();
        await mountCompose();
        const up = w.findComponent(VUpload);
        up.vm.$emit('start');
        await flushPromises();
        expect(s().uploading).toBe(true);
        up.vm.$emit('input', null);
        await flushPromises();
        expect(s().uploading).toBe(false);
        expect(w.find('.notice-danger').text()).toBe('The file could not be attached.');

        up.vm.$emit('input', { id: 'f1', filename_download: 'a.txt', filesize: 500 });
        up.vm.$emit('input', [{ id: 'f1' }, { id: 'f2', title: 'Two', filesize: 1000 }, { id: 'f3' }, {}]);
        await flushPromises();
        expect(s().attachments.map((f: any) => f.id)).toEqual(['f1', 'f2', 'f3']);
        expect(w.find('.att-total').text()).toMatch(/3 files,\s+1\.5 KB of 2\.0 KB/);
        expect(w.text()).toContain('a.txt');
        expect(w.text()).toContain('Two');
        expect(w.text()).toContain('f3');
        expect(w.text()).toContain('0 B');

        up.vm.$emit('input', { id: 'big', filesize: 5 * 1024 ** 4 });
        await flushPromises();
        expect(w.find('.att-total').classes()).toContain('over');
        expect(w.text()).toContain('over the');
        expect(w.text()).toMatch(/GB/);

        const chipX = w.findAll('.chip .chip-x');
        await chipX[chipX.length - 1]!.trigger('click');
        await chipX[1]!.trigger('click');
        await chipX[2]!.trigger('click');
        expect(s().attachments.map((f: any) => f.id)).toEqual(['f1']);
        expect(w.find('.att-total').text()).toMatch(/^1 file,/);
    });

    it('send is disabled until the message is complete', async () => {
        gets();
        await mountCompose();
        const disabled = () => sendBtn().attributes('disabled') !== undefined;
        expect(disabled()).toBe(true);
        s().subject = 'Hi';
        s().bodyHtml = '<p>x</p>';
        await flushPromises();
        expect(disabled()).toBe(true); // no recipients
        s().selectedUsers = [USERS[0]];
        await flushPromises();
        expect(disabled()).toBe(false);
        s().uploading = true;
        await flushPromises();
        expect(disabled()).toBe(true);
        s().uploading = false;
        s().mode = 'external';
        await flushPromises();
        expect(disabled()).toBe(true);
        s().to = ' a@x ';
        await flushPromises();
        expect(disabled()).toBe(false);
        // submit() itself guards too
        s().subject = '';
        await s().submit();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('sends an internal HTML message with attachments and navigates to Sent', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        gets();
        await mountCompose();
        s().selectedUsers = [USERS[0], USERS[1]];
        await w.findAll('input.v-input')[1]!.setValue('Subject');
        w.findComponent(RichText).vm.$emit('input', '<p>hello</p>');
        s().attachments = [{ id: 'f1' }];
        await flushPromises();
        api.post.mockResolvedValue({ data: { thread_id: 'th' } });
        await sendBtn().trigger('click');
        await flushPromises();
        expect(api.post).toHaveBeenCalledWith('/email/internal/send', {
            to_user: ['u1', 'u2'], subject: 'Subject', body_html: '<p>hello</p>', attachment_ids: ['f1'],
        });
        expect(w.find('.notice-success').text()).toBe('Internal message sent (thread th).');
        vi.advanceTimersByTime(800);
        expect(router.push).toHaveBeenCalledWith('/email/sent');
    });

    it('sends an internal plain-text message', async () => {
        gets();
        await mountCompose();
        s().selectedUsers = [USERS[2]];
        s().subject = 'S';
        await w.find('input.v-checkbox').setValue(false);
        await w.find('textarea').setValue('plain');
        api.post.mockResolvedValue({ data: null });
        await s().submit();
        expect(api.post).toHaveBeenCalledWith('/email/internal/send', { to_user: ['u3'], subject: 'S', body_text: 'plain' });
        expect(s().success).toBe('Internal message sent (thread —).');
    });

    it('sends an external message with cc, attachments, reply-to', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        gets();
        await mountCompose();
        Object.assign(s(), {
            mode: 'external', to: 'a@x, , b@x', cc: 'c@x', subject: 'S', bodyHtml: '<b>x</b>',
            attachments: [{ id: 'f1' }, { id: 'f2' }], replyTo: '<m@id>',
        });
        api.post.mockResolvedValue({ data: { id: 42 } });
        await s().submit();
        expect(api.post).toHaveBeenCalledWith('/email/send', {
            to: ['a@x', 'b@x'], cc: ['c@x'], subject: 'S', attachment_ids: ['f1', 'f2'], html: '<b>x</b>', in_reply_to: '<m@id>',
        });
        expect(s().success).toBe('Sent (id 42).');
        vi.advanceTimersByTime(800);
        expect(router.push).toHaveBeenCalledWith('/email/sent');
    });

    it('sends a minimal external text message', async () => {
        gets();
        await mountCompose();
        Object.assign(s(), { mode: 'external', to: 'a@x', cc: '  ', subject: 'S', htmlMode: false, bodyText: 't' });
        api.post.mockResolvedValue({});
        await s().submit();
        expect(api.post).toHaveBeenCalledWith('/email/send', { to: ['a@x'], subject: 'S', text: 't' });
        expect(s().success).toBe('Sent (id —).');
    });

    it('reports send failures', async () => {
        gets();
        await mountCompose();
        Object.assign(s(), { selectedUsers: [USERS[0]], subject: 'S', bodyText: 't', htmlMode: false });
        for (const [err, msg] of [
            [httpError(400, { message: 'bad' }), 'bad'],
            [new Error('net'), 'net'],
            [{}, 'Could not send the message.'],
        ] as const) {
            api.post.mockRejectedValueOnce(err);
            await s().submit();
            await flushPromises();
            expect(w.find('.notice-danger').text()).toBe(msg);
            expect(s().submitting).toBe(false);
        }
    });
});
