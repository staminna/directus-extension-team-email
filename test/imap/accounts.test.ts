import { describe, expect, it } from 'vitest';
import {
    ACCOUNTS_COLLECTION, decryptFor, deleteForOwner, findByOwner, listActive, patchSyncState,
    toPublic, upsertForOwner, usernameAllowed, type ImapAccountRow,
} from '../../src/api/imap/accounts';
import { readImapConfig } from '../../src/api/imap/config';
import { makeItemsService } from './helpers';

const cfg = readImapConfig({ EMAIL_IMAP_SECRET: 's'.repeat(32) });

function setup() {
    const svc = makeItemsService();
    const deps = { ItemsService: svc.ItemsService, schema: {}, database: {} };
    return { ...svc, deps };
}

describe('imap accounts', () => {
    it('toPublic strips the password and normalises fields', () => {
        const row = {
            id: 'a', owner: 'u', host: 'h', port: '993' as any, secure: 1 as any, username: 'x@y',
            password_enc: 'enc', mailbox: '', is_active: 0 as any, initial_days: '7' as any,
            uid_validity: null, last_uid: '12', last_sync_at: null, last_sync_status: null, last_error: null,
        } as ImapAccountRow;
        const p = toPublic(row);
        expect(p).toEqual({
            id: 'a', host: 'h', port: 993, secure: true, username: 'x@y', mailbox: 'INBOX', is_active: false,
            initial_days: 7, has_password: true, last_uid: 12, last_sync_at: null, last_sync_status: 'never', last_error: null,
        });
        expect(p).not.toHaveProperty('password_enc');
        expect(toPublic({ ...row, initial_days: null, last_uid: null, password_enc: '', last_sync_status: 'ok' }))
            .toMatchObject({ initial_days: null, last_uid: 0, has_password: false, last_sync_status: 'ok' });
    });

    it('creates, finds, lists, updates, decrypts and deletes', async () => {
        const { deps, store } = setup();
        expect(await findByOwner(deps, 'u1')).toBeNull();

        await expect(upsertForOwner(deps, cfg, 'u1', { host: 'h', port: 993, secure: true, username: 'a@b' }, null))
            .rejects.toThrow(/password is required/);

        const created = await upsertForOwner(deps, cfg, 'u1',
            { host: 'h', port: 993, secure: true, username: 'a@b', password: 'pw', initial_days: 5 }, null);
        expect(created).toMatchObject({ owner: 'u1', mailbox: 'INBOX', is_active: true, last_uid: 0, last_sync_status: 'never', initial_days: 5 });
        expect(decryptFor(cfg, created)).toBe('pw');

        const found = await findByOwner(deps, 'u1');
        expect(found?.id).toBe(created.id);
        expect((await listActive(deps)).map(r => r.id)).toEqual([created.id]);

        // Same server/user/mailbox: cursor kept.
        await patchSyncState(deps, created.id, { last_uid: 40, uid_validity: 9, last_sync_status: 'ok' });
        const same = await upsertForOwner(deps, cfg, 'u1',
            { host: 'h', port: 143, secure: false, username: 'a@b', is_active: false }, found);
        expect(same).toMatchObject({ port: 143, last_uid: 40, uid_validity: 9, is_active: false });
        expect(decryptFor(cfg, same)).toBe('pw');
        expect(await listActive(deps)).toEqual([]);

        // Changed mailbox: cursor reset and new password stored.
        const moved = await upsertForOwner(deps, cfg, 'u1',
            { host: 'h', port: 993, secure: true, username: 'a@b', mailbox: 'Archive', password: 'pw2' }, same);
        expect(moved).toMatchObject({ mailbox: 'Archive', last_uid: 0, uid_validity: null, last_sync_status: 'never', last_error: null });
        expect(decryptFor(cfg, moved)).toBe('pw2');

        await deleteForOwner(deps, moved);
        expect(store[ACCOUNTS_COLLECTION]!.size).toBe(0);
    });

    it('resets cursor on host or username change', async () => {
        const { deps } = setup();
        const a = await upsertForOwner(deps, cfg, 'u', { host: 'h', port: 1, secure: true, username: 'a@b', password: 'p' }, null);
        await patchSyncState(deps, a.id, { last_uid: 5 });
        const b = await upsertForOwner(deps, cfg, 'u', { host: 'h2', port: 1, secure: true, username: 'a@b' }, { ...a, mailbox: '' as any });
        expect(b.last_uid).toBe(0);
    });

    it('usernameAllowed', () => {
        expect(usernameAllowed(cfg, 'anything')).toBe(true);
        const restricted = readImapConfig({ EMAIL_IMAP_ALLOWED_DOMAINS: 'example.com' });
        expect(usernameAllowed(restricted, 'me@Example.com')).toBe(true);
        expect(usernameAllowed(restricted, 'me@other.com')).toBe(false);
        expect(usernameAllowed(restricted, 'nobody')).toBe(false);
    });
});
