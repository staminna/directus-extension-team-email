// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImapSettings from '../../src/module/routes/ImapSettings.vue';
import { api, resetApi } from '../mocks/extensions-sdk';
import { leaveGuards, resetRouter } from '../mocks/vue-router';
import { httpError, mockConfirm, stubs } from './helpers';

const put = vi.fn();
(api as any).put = put;

const ACCOUNT = {
    id: 'a1', host: 'imap.x.test', port: 993, secure: true, username: 'me@x.test', mailbox: 'INBOX',
    is_active: true, initial_days: 14, has_password: true, last_uid: 55,
    last_sync_at: '2026-01-01T00:00:00Z', last_sync_status: 'ok', last_error: null,
};

let w: ReturnType<typeof mount>;
async function mountSettings(data: any) {
    if (data instanceof Error) api.get.mockRejectedValueOnce(data);
    else api.get.mockResolvedValueOnce({ data });
    w = mount(ImapSettings, { global: { stubs } });
    await flushPromises();
    return w;
}
const s = () => (w.vm as any).$.setupState;
const btn = (label: string) => w.findAll('.v-button').find(b => b.text().includes(label))!;

describe('ImapSettings', () => {
    beforeEach(() => { resetApi(); resetRouter(); put.mockReset(); });
    afterEach(() => { w?.unmount(); vi.useRealTimers(); });

    it('new user: shows defaults, the not-connected warning and allowed domains', async () => {
        await mountSettings({ account: null, secret_configured: true, defaults: { host: 'imap.d', port: 143, secure: false, mailbox: 'Box', initial_days: 7, allowed_domains: ['x.test', 'y.test'] } });
        expect(s().form).toMatchObject({ host: 'imap.d', port: 143, secure: false, username: '', mailbox: 'Box', initial_days: 7, is_active: true });
        expect(w.text()).toContain('No mailbox connected');
        expect(w.text()).toContain('Allowed: @x.test, @y.test');
        expect(w.find('.status').exists()).toBe(false);
        expect(btn('Connect mailbox').attributes('disabled')).toBeDefined();
        expect(btn('Remove')).toBeUndefined();
    });

    it('applies built-in defaults when the payload is empty', async () => {
        await mountSettings(null);
        expect(s().form).toMatchObject({ host: '', port: 993, secure: true, mailbox: 'INBOX', initial_days: 30, is_active: true });
        expect(s().allowedDomains).toEqual([]);
        expect(s().secretConfigured).toBe(true);
    });

    it('server without secret: danger notice, actions disabled', async () => {
        await mountSettings({ account: null, secret_configured: false, defaults: {} });
        expect(w.find('.notice-danger').text()).toContain('EMAIL_IMAP_SECRET');
        expect(w.text()).not.toContain('No mailbox connected');
        expect(btn('Test connection').attributes('disabled')).toBeDefined();
    });

    it('load error is shown', async () => {
        await mountSettings(httpError(500, { message: 'db down' }));
        expect(w.find('.notice-danger').text()).toBe('db down');
    });

    it('existing account: status line', async () => {
        await mountSettings({ account: { ...ACCOUNT, is_active: false, last_error: 'AUTH failed', last_sync_status: 'error' } });
        expect(s().form).toMatchObject({ host: 'imap.x.test', username: 'me@x.test', initial_days: 14, is_active: false });
        expect(w.find('.status-title').text()).toContain('me@x.test');
        expect(w.find('.status-title').text()).toContain('on imap.x.test:993 · INBOX');
        expect(w.find('.v-chip').text()).toBe('paused');
        expect(w.find('.status-error').text()).toBe('AUTH failed');
        expect(w.text()).toContain('cursor UID 55');
        expect(w.text()).toContain('· error');
        expect(w.find('[data-icon="error"]').exists()).toBe(true);
        expect(btn('Sync now').attributes('disabled')).toBeDefined();
        expect(btn('Save changes').attributes('disabled')).toBeUndefined();
        expect(w.find('input[type="password"]').attributes('placeholder')).toBe('•••••••• (unchanged)');
    });

    it('status icon and last-sync label variants', async () => {
        await mountSettings({ account: { ...ACCOUNT, last_sync_at: null, last_sync_status: 'idle', last_uid: 0 } });
        expect(s().lastSyncLabel).toBe('never');
        expect(s().statusIcon).toBe('schedule');
        expect(w.text()).not.toContain('cursor UID');
        s().account = { ...ACCOUNT };
        expect(s().statusIcon).toBe('check_circle');
        expect(s().lastSyncLabel).toBe(new Date(ACCOUNT.last_sync_at).toLocaleString());
        s().account = { ...ACCOUNT, last_sync_at: 'garbage' };
        expect(s().lastSyncLabel).toBe('garbage');
    });

    it('polls while a sync is running and stops when it finishes', async () => {
        vi.useFakeTimers();
        api.get.mockResolvedValueOnce({ data: { account: { ...ACCOUNT, last_sync_status: 'running' } } });
        w = mount(ImapSettings, { global: { stubs } });
        await vi.advanceTimersByTimeAsync(0);
        expect(s().statusIcon).toBe('sync');
        expect(w.text()).toContain('syncing…');

        api.get.mockResolvedValueOnce({ data: { account: { ...ACCOUNT, syncing: true } } });
        await vi.advanceTimersByTimeAsync(4000);
        expect(api.get).toHaveBeenCalledTimes(2);
        api.get.mockRejectedValueOnce(new Error('blip')); // keeps last state
        await vi.advanceTimersByTimeAsync(4000);
        expect(s().account.syncing).toBe(true);
        api.get.mockResolvedValueOnce({ data: { account: ACCOUNT } });
        await vi.advanceTimersByTimeAsync(4000);
        expect(api.get).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(8000);
        expect(api.get).toHaveBeenCalledTimes(4);
    });

    it('clears the poll timer on unmount', async () => {
        await mountSettings({ account: { ...ACCOUNT, syncing: true } });
        const clear = vi.spyOn(globalThis, 'clearInterval');
        w.unmount();
        expect(clear).toHaveBeenCalled();
    });

    it('form fields are bound to the model', async () => {
        await mountSettings({ account: null, defaults: {} });
        const inputs = w.findAll('input.v-input');
        await inputs[0]!.setValue('imap.new');
        await inputs[1]!.setValue('1143');
        await inputs[4]!.setValue('Archive');
        await inputs[5]!.setValue('90');
        await w.findAll('input.v-checkbox')[1]!.setValue(false);
        expect(s().form).toMatchObject({ host: 'imap.new', port: '1143', mailbox: 'Archive', initial_days: '90', is_active: false });
    });

    it('a status refresh without an account clears it', async () => {
        await mountSettings({ account: ACCOUNT });
        api.get.mockResolvedValueOnce({ data: {} });
        await s().refreshStatus();
        expect(s().account).toBeNull();
    });

    it('toggling TLS swaps the default port only', async () => {
        await mountSettings({ account: null, defaults: {} });
        const tls = w.findAll('input.v-checkbox')[0]!;
        await tls.setValue(false);
        expect(s().form).toMatchObject({ secure: false, port: 143 });
        await tls.setValue(true);
        expect(s().form).toMatchObject({ secure: true, port: 993 });
        s().form.port = 1993;
        s().onSecureToggle(false);
        expect(s().form.port).toBe(1993);
        s().onSecureToggle(true);
        expect(s().form.port).toBe(1993);
    });

    it('test connection: warns when unsaved, confirms when saved', async () => {
        await mountSettings({ account: null, defaults: { host: 'h' } });
        await w.findAll('input.v-input')[2]!.setValue('me@x');
        await w.find('input[type="password"]').setValue('pw');
        s().form.mailbox = '';
        api.post.mockResolvedValueOnce({ data: { exists: 3 } });
        await btn('Test connection').trigger('click');
        await flushPromises();
        expect(api.post).toHaveBeenCalledWith('/email/imap/test', {
            host: 'h', port: 993, secure: true, username: 'me@x', mailbox: 'INBOX', initial_days: 30, is_active: true, password: 'pw',
        });
        expect(s().noticeType).toBe('warning');
        expect(s().notice).toBe('Connection OK — 3 message(s) in INBOX. Not saved yet — click “Connect mailbox” to store these credentials.');
        w.unmount();

        await mountSettings({ account: ACCOUNT });
        api.post.mockResolvedValueOnce({ data: {} });
        await s().test();
        expect(s().noticeType).toBe('success');
        expect(s().notice).toBe('Connection OK — 0 message(s) in INBOX.');
        expect(w.find('.notice-success').exists()).toBe(true);

        s().form.host = 'changed';
        api.post.mockResolvedValueOnce({ data: { exists: 1 } });
        await s().test();
        expect(s().notice).toContain('click “Save changes”');

        api.post.mockRejectedValueOnce(httpError(400, { error: 'LOGIN failed' }));
        await s().test();
        expect(s().error).toBe('LOGIN failed');
        api.post.mockRejectedValueOnce({});
        await s().test();
        expect(s().error).toBe('Connection failed.');
        expect(s().busy).toBeNull();
    });

    it('save stores the account and reports whether a sync started', async () => {
        await mountSettings({ account: null, defaults: { host: 'h' } });
        Object.assign(s().form, { username: 'u', password: 'p' });
        await flushPromises();
        put.mockResolvedValueOnce({ data: { account: ACCOUNT, sync: 'started' } });
        await btn('Connect mailbox').trigger('click');
        await flushPromises();
        expect(put).toHaveBeenCalledWith('/email/imap/account', expect.objectContaining({ host: 'h', username: 'u', password: 'p' }));
        expect(s().notice).toMatch(/^Saved\. First sync started/);
        expect(s().form.password).toBe('');
        expect(s().hasUnsaved).toBe(false);

        put.mockResolvedValueOnce({ data: { account: ACCOUNT } });
        await s().save();
        expect(s().notice).toBe('Saved.');

        put.mockRejectedValueOnce(new Error('nope'));
        await s().save();
        expect(s().error).toBe('nope');
    });

    it('sync now reports each outcome and refreshes status', async () => {
        await mountSettings({ account: ACCOUNT });
        api.get.mockResolvedValue({ data: { account: ACCOUNT } });
        const run = async (res: any, reject = false) => {
            if (reject) api.post.mockRejectedValueOnce(res); else api.post.mockResolvedValueOnce({ data: res });
            await s().syncNow();
            return reject ? s().error : s().notice;
        };
        expect(await run({ status: 'ok', stored: 2, skipped: 1 })).toBe('Synced: 2 new, 1 already present.');
        expect(api.post).toHaveBeenLastCalledWith('/email/imap/sync', null, { params: { force: 1 } });
        expect(await run({ status: 'ok', stored: 0, skipped: 0, truncated: true })).toBe('Synced: 0 new, 0 already present (more pending — next run continues).');
        expect(await run({ status: 'running' })).toBe('A sync is already running.');
        expect(await run({ status: 'skipped', reason: 'inactive' })).toBe('Sync skipped (inactive).');
        expect(await run(null)).toBe('Sync done.');
        expect(await run(httpError(429, { message: 'too soon' }), true)).toBe('too soon');
        expect(api.get).toHaveBeenCalledTimes(7);
        await btn('Sync now').trigger('click');
    });

    it('remove asks first, then reloads', async () => {
        await mountSettings({ account: ACCOUNT });
        const confirm = mockConfirm(false);
        await btn('Remove').trigger('click');
        expect(api.delete).not.toHaveBeenCalled();
        confirm.mockReturnValue(true);
        api.delete.mockResolvedValueOnce({});
        api.get.mockResolvedValueOnce({ data: { account: null, defaults: {} } });
        await s().remove();
        expect(api.delete).toHaveBeenCalledWith('/email/imap/account');
        expect(s().account).toBeNull();
        expect(s().notice).toBe('Mailbox connection removed.');
        api.delete.mockRejectedValueOnce(new Error('locked'));
        await s().remove();
        expect(s().error).toBe('locked');
    });

    it('guards against leaving with unsaved changes', async () => {
        await mountSettings({ account: ACCOUNT });
        const guard = leaveGuards[0]!;
        expect(guard()).toBe(true);
        const ev = { preventDefault: vi.fn(), returnValue: 'x' } as any;
        s().beforeUnload(ev);
        expect(ev.preventDefault).not.toHaveBeenCalled();

        s().form.password = 'new';
        const confirm = mockConfirm(false);
        expect(guard()).toBe(false);
        expect(confirm).toHaveBeenCalled();
        s().beforeUnload(ev);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(ev.returnValue).toBe('');

        const remove = vi.spyOn(window, 'removeEventListener');
        w.unmount();
        expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    });
});
