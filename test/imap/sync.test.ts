import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeImapFlow, imapState, postalParse, resetImap } from './fake-imap';

vi.mock('imapflow', async () => ({ ImapFlow: (await import('./fake-imap')).FakeImapFlow }));
vi.mock('postal-mime', async () => ({ default: { parse: (await import('./fake-imap')).postalParse } }));

import { encryptPassword } from '../../src/api/imap/crypto';
import { readImapConfig } from '../../src/api/imap/config';
import { isRunning, syncAccount, verifyConnection } from '../../src/api/imap/sync';
import { logger, makeItemsService } from './helpers';

const SECRET = 'k'.repeat(32);
const baseCfg = readImapConfig({ EMAIL_IMAP_SECRET: SECRET, EMAIL_ATTACHMENTS_FOLDER: 'fold' });

function setup(rowOver: any = {}, cfgOver: any = {}) {
    const items = makeItemsService();
    const uploads: any[] = [];
    class FilesService {
        async uploadOne(stream: any, data: any) {
            const chunks: Buffer[] = [];
            for await (const c of stream) chunks.push(Buffer.from(c));
            if (data.filename_download === 'explode.bin') throw new Error('upload failed');
            uploads.push({ data, body: Buffer.concat(chunks) });
            return `file-${uploads.length}`;
        }
    }
    const log = logger();
    const deps = { ItemsService: items.ItemsService, FilesService, schema: {}, database: {}, logger: log };
    const row: any = {
        id: 'acc1', owner: 'user1', host: 'imap.test', port: 993, secure: true, username: 'me@test.com',
        password_enc: encryptPassword(SECRET, 'pw', 'user1'), mailbox: 'INBOX', is_active: true,
        initial_days: null, uid_validity: null, last_uid: 0, last_sync_at: null, last_sync_status: 'never', last_error: null,
        ...rowOver,
    };
    items.store.email_imap_accounts = new Map([[row.id, { ...row }]]);
    const cfg = { ...baseCfg, ...cfgOver };
    const inbox = () => [...(items.store.inbox_email?.values() ?? [])];
    const account = () => items.store.email_imap_accounts!.get(row.id);
    return { deps, row, cfg, items, uploads, log, inbox, account };
}

beforeEach(() => {
    resetImap();
    postalParse.mockReset();
});

describe('verifyConnection', () => {
    it('reports mailbox info and builds a STARTTLS client for plain ports', async () => {
        imapState.mailbox = { exists: 3, uidNext: 10, uidValidity: 1n };
        const r = await verifyConnection(baseCfg, { host: 'h', port: 143, secure: false, username: 'u', password: 'p', mailbox: '' });
        expect(r).toEqual({ exists: 3, uid_next: 10 });
        const c = imapState.clients[0];
        expect(c.opts).toMatchObject({ host: 'h', port: 143, secure: false, doSTARTTLS: true, auth: { user: 'u', pass: 'p' } });
        expect(c.locked).toEqual({ path: 'INBOX', opts: { readOnly: true } });
        expect(imapState.release).toHaveBeenCalled();
        expect(imapState.logout).toHaveBeenCalled();
    });

    it('handles an empty mailbox object and secure connections', async () => {
        imapState.mailbox = undefined;
        const r = await verifyConnection(baseCfg, { host: 'h', port: 993, secure: true, username: 'u', password: 'p', mailbox: 'Archive' });
        expect(r).toEqual({ exists: 0, uid_next: null });
        expect(imapState.clients[0].opts.doSTARTTLS).toBeUndefined();
    });

    it('closes the socket when logout fails, ignoring close errors', async () => {
        imapState.logout = vi.fn(async () => { throw new Error('nope'); });
        imapState.close = vi.fn(() => { throw new Error('closed'); });
        await verifyConnection(baseCfg, { host: 'h', port: 993, secure: true, username: 'u', password: 'p', mailbox: 'INBOX' });
        expect(imapState.close).toHaveBeenCalled();
    });

    it('times out a hanging connect and closes the client', async () => {
        vi.useFakeTimers();
        try {
            imapState.connect = vi.fn(() => new Promise<void>(() => {}));
            imapState.close = vi.fn(() => { throw new Error('x'); });
            const p = verifyConnection(baseCfg, { host: 'h', port: 993, secure: true, username: 'u', password: 'p', mailbox: 'INBOX' });
            const assertion = expect(p).rejects.toThrow(/imap connect timed out after 30000ms/);
            await vi.advanceTimersByTimeAsync(30_000);
            await assertion;
            expect(imapState.close).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('syncAccount', () => {
    it('first sync stores parsed messages with threading, attachments and flags', async () => {
        const s = setup({ initial_days: 7 });
        s.items.store.emails = new Map([['e1', { id: 'e1', message_id: '<parent@x>', thread_id: 'thread-sent' }]]);
        imapState.mailbox = { uidValidity: 77n, uidNext: 4, exists: 3 };
        imapState.messages = [
            { uid: 1, size: 100, flags: new Set(['\\Seen']), internalDate: '2026-01-01T00:00:00Z', envelope: {}, source: Buffer.from('m1') },
            { uid: 2, size: 100, flags: ['\\Flagged'], internalDate: 'garbage', envelope: { date: '2026-02-02T00:00:00Z' }, source: Buffer.from('m2') },
            { uid: 3, size: 100, flags: undefined, envelope: {}, source: Buffer.from('m3') },
        ];
        postalParse.mockImplementation(async (src: Buffer) => {
            const n = src.toString();
            if (n === 'm1') return {
                messageId: 'abc@x', inReplyTo: '<parent@x>', references: '<root@x>  <parent@x>',
                from: { address: ' a@x ', name: 'Alice' }, to: [{ address: 'me@test.com', name: 'Me' }, { address: '' }],
                cc: [{ address: 'c@x' }], replyTo: [{ address: 'r@x' }], subject: 'Hello', html: '<p>Hi&amp;bye</p>', text: 'Hi',
                headers: [{ key: 'x-a', value: '1', extra: true }],
                attachments: [
                    { filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('aaa') },
                    { contentId: '<cid1>', content: 'aGVsbG8=', encoding: 'base64' },
                    { content: 'plain', mimeType: 'text/plain' },
                    { content: new Uint8Array([1, 2]).buffer },
                    { filename: 'explode.bin', content: Buffer.from('z') },
                ],
            };
            if (n === 'm2') return { messageId: '<m2@x>', html: '<style>x</style><script>y</script><div>A<br>B</div>&lt;&gt;&quot;&#39;&nbsp;', date: '2026-03-03T00:00:00Z' };
            return { subject: '', date: 'not a date' };
        });

        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r).toMatchObject({ status: 'ok', fetched: 3, stored: 3, skipped: 0, last_uid: 3, truncated: false });
        expect(imapState.clients[0].searches[0]).toHaveProperty('since');
        const rows = s.inbox().sort((a, b) => a.raw_payload.imap.uid - b.raw_payload.imap.uid);
        expect(rows[0]).toMatchObject({
            source: 'imap', from_address: 'a@x', from_name: 'Alice', subject: 'Hello', body_text: 'Hi',
            message_id: '<abc@x>', in_reply_to: '<parent@x>', references_header: '<root@x> <parent@x>',
            thread_id: 'thread-sent', provider_message_id: 'imap:77:1', is_read: true,
            read_at: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:00.000Z',
            owner: 'user1', reply_to: 'r@x', to_addresses: [{ email: 'me@test.com', name: 'Me' }], cc_addresses: [{ email: 'c@x', name: undefined }],
        });
        expect(rows[0].raw_payload.headers).toEqual([{ key: 'x-a', value: '1' }]);
        expect(rows[0].raw_payload.imap.flags).toEqual(['\\Seen']);
        expect(rows[0].attachments).toEqual([{ directus_files_id: 'file-1' }, { directus_files_id: 'file-2' }, { directus_files_id: 'file-3' }, { directus_files_id: 'file-4' }]);
        expect(s.uploads.map(u => u.data.filename_download)).toEqual(['a.txt', 'inline-cid1', 'attachment-3', 'attachment-4']);
        expect(s.uploads[1].body.toString()).toBe('hello');
        expect(s.uploads[2].data.type).toBe('text/plain');
        expect(s.uploads[3].data.type).toBe('application/octet-stream');
        expect(s.uploads[0].data.folder).toBe('fold');
        expect(s.log.error).toHaveBeenCalledWith(expect.objectContaining({ filename: 'explode.bin' }), expect.any(String));

        expect(rows[1]).toMatchObject({ is_read: false, body_text: 'A\nB\n<>"\'', received_at: '2026-03-03T00:00:00.000Z', subject: '(no subject)', references_header: null });
        expect(rows[1].raw_payload.headers).toBeNull();
        expect(rows[1].thread_id).toMatch(/[0-9a-f-]{36}/);
        expect(rows[2].subject).toBe('(no subject)');
        expect(rows[2].message_id).toBeNull();

        expect(s.account()).toMatchObject({ uid_validity: '77', last_uid: 3, last_sync_status: 'ok', last_error: null });
        expect(isRunning('acc1')).toBe(false);
        expect(s.log.info).toHaveBeenCalled();
    });

    it('incremental sync threads via inbox parents, skips duplicates and oversize bodies', async () => {
        const s = setup({ uid_validity: '5', last_uid: 10 }, { maxMessageBytes: 1000, attachmentsFolder: null });
        s.items.store.inbox_email = new Map([
            ['p', { id: 'p', message_id: '<parent@x>', thread_id: 'thread-in', owner: 'other' }],
            ['d', { id: 'd', source: 'imap', provider_message_id: 'imap:5:11', owner: 'user1' }],
            ['m', { id: 'm', message_id: '<mirror@x>', owner: 'user1' }],
        ]);
        imapState.mailbox = { uidValidity: 5n, uidNext: 20 };
        imapState.messages = [
            { uid: 9, size: 1 },
            { uid: 11, size: 1, source: Buffer.from('dup') },
            { uid: 12, size: 1, source: Buffer.from('mirror') },
            { uid: 13, size: 2 * 1024 * 1024, envelope: { from: [{ address: 'big@x', name: '' }], subject: 'Big', inReplyTo: 'parent@x', date: '2026-05-05T00:00:00Z', to: [{ address: 't@x', name: 'T' }] } },
            { uid: 14, size: 1, source: Buffer.from('bad'), envelope: { messageId: 'env@x' } },
        ];
        postalParse.mockImplementation(async (src: Buffer) => {
            if (src.toString() === 'mirror') return { messageId: 'mirror@x' };
            throw new Error('parse fail');
        });
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(imapState.clients[0].searches[0]).toEqual({ uid: '11:*' });
        expect(r).toMatchObject({ status: 'ok', fetched: 4, stored: 2, skipped: 2, last_uid: 14 });
        const big = s.inbox().find(x => x.provider_message_id === 'imap:5:13');
        expect(big).toMatchObject({
            from_address: 'big@x', from_name: null, subject: 'Big', body_html: null, thread_id: 'thread-in',
            body_text: '(message not imported: 2.0 MB exceeds the 0 MB limit — open it in your mail client)',
            received_at: '2026-05-05T00:00:00.000Z', to_addresses: [{ email: 't@x', name: 'T' }],
        });
        const bad = s.inbox().find(x => x.provider_message_id === 'imap:5:14');
        expect(bad).toMatchObject({ message_id: '<env@x>', from_address: null });
        expect(s.log.warn).toHaveBeenCalledWith(expect.objectContaining({ uid: 14 }), expect.stringContaining('could not parse'));
    });

    it('does nothing when uidNext shows no new mail', async () => {
        const s = setup({ uid_validity: 5, last_uid: 10 });
        imapState.mailbox = { uidValidity: 5n, uidNext: 11 };
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r).toMatchObject({ status: 'ok', fetched: 0, last_uid: 10 });
        expect(imapState.clients[0].searches).toEqual([]);
        expect(s.log.info).not.toHaveBeenCalled();
        expect(s.account()).toMatchObject({ uid_validity: '5', last_uid: 10 });
    });

    it('resets the cursor on UIDVALIDITY change, truncates and tolerates non-array search', async () => {
        const s = setup({ uid_validity: '4', last_uid: 50, initial_days: 0 }, { maxPerSync: 2 });
        imapState.mailbox = { uidValidity: 9n, uidNext: null };
        imapState.messages = [1, 2, 3].map(uid => ({ uid, size: 1, source: Buffer.from('x') }));
        postalParse.mockResolvedValue({ from: null, attachments: [] });
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(s.log.warn).toHaveBeenCalledWith(expect.stringContaining('UIDVALIDITY changed 4 -> 9'));
        expect(r).toMatchObject({ truncated: true, fetched: 2, stored: 2, last_uid: 2 });
        expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining('(more pending)'));

        resetImap();
        imapState.search = () => null;
        const s2 = setup();
        expect(await syncAccount(s2.deps as any, s2.cfg, s2.row)).toMatchObject({ status: 'ok', fetched: 0 });

        resetImap();
        imapState.search = () => 'nope';
        const s3 = setup({ uid_validity: 1, last_uid: 3 });
        imapState.mailbox = { uidValidity: 1n, uidNext: 99 };
        expect(await syncAccount(s3.deps as any, s3.cfg, s3.row)).toMatchObject({ status: 'ok', fetched: 0, last_uid: 3 });
    });

    it('caps attachments by total size', async () => {
        const s = setup({}, { maxAttachmentBytes: 4 });
        imapState.messages = [{ uid: 1, size: 1, source: Buffer.from('x') }];
        postalParse.mockResolvedValue({ attachments: [{ filename: 'a', content: Buffer.from('abc') }, { filename: 'b', content: Buffer.from('def') }] });
        await syncAccount(s.deps as any, s.cfg, s.row);
        expect(s.uploads).toHaveLength(1);
        expect(s.log.warn).toHaveBeenCalledWith(expect.stringContaining('attachment cap reached on uid 1'));
    });

    it('counts a message whose store throws as skipped and still advances', async () => {
        const s = setup();
        imapState.messages = [{ uid: 1, size: 1, source: Buffer.from('x') }];
        postalParse.mockResolvedValue({});
        const orig = s.items.ItemsService.prototype.createOne;
        s.items.ItemsService.prototype.createOne = async function (this: any, d: any) {
            if (this.collection === 'inbox_email') throw new Error('db down');
            return orig.call(this, d);
        };
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r).toMatchObject({ status: 'ok', stored: 0, skipped: 1, last_uid: 1 });
        expect(s.log.error).toHaveBeenCalled();
    });

    it('reports errors (auth, codes) and records them on the account', async () => {
        const s = setup();
        imapState.connect = vi.fn(async () => { throw Object.assign(new Error('bad'), { authenticationFailed: true }); });
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r).toMatchObject({ status: 'error', error: 'authentication failed: check the mailbox username and password' });
        expect(s.account()).toMatchObject({ last_sync_status: 'error', last_error: r.error });

        imapState.connect = vi.fn(async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); });
        expect((await syncAccount(s.deps as any, s.cfg, s.row)).error).toBe('refused [ECONNREFUSED]');

        imapState.connect = vi.fn(async () => { throw 'str'; });
        expect((await syncAccount(s.deps as any, s.cfg, s.row)).error).toBe('str');

        imapState.connect = vi.fn(async () => { throw null; });
        expect((await syncAccount(s.deps as any, s.cfg, s.row)).error).toBe('unknown error');
    });

    it('fails without a client when the password cannot be decrypted, ignoring bookkeeping errors', async () => {
        const s = setup({ password_enc: 'garbage' });
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r.status).toBe('error');
        expect(imapState.clients).toHaveLength(0);

        const s2 = setup();
        s2.items.ItemsService.prototype.updateOne = async () => { throw new Error('db'); };
        expect((await syncAccount(s2.deps as any, s2.cfg, s2.row))).toMatchObject({ status: 'error', error: 'db' });
    });

    it('times out a stuck sync and closes the client', async () => {
        const s = setup({}, { syncTimeoutMs: 20 });
        imapState.connect = vi.fn(() => new Promise<void>(() => {}));
        imapState.close = vi.fn(() => { throw new Error('x'); });
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r.error).toMatch(/sync timed out after 20ms/);
        expect(imapState.close).toHaveBeenCalled();
    });

    it('handles default mailbox, null cursor, missing sizes and sources', async () => {
        const s = setup({ mailbox: '', last_uid: null });
        imapState.messages = [{ uid: 1, envelope: { subject: 'S' }, source: null }];
        const r = await syncAccount(s.deps as any, s.cfg, s.row);
        expect(r).toMatchObject({ status: 'ok', stored: 1, last_uid: 1 });
        expect(imapState.clients[0].locked.path).toBe('INBOX');
        const row = s.inbox()[0];
        expect(row.raw_payload.imap).toMatchObject({ mailbox: 'INBOX', size: null, flags: [] });
        expect(row.body_text).toMatch(/0\.0 MB exceeds/);
        expect(postalParse).not.toHaveBeenCalled();

        resetImap();
        const s2 = setup({}, { maxMessageBytes: 10 });
        imapState.messages = [{ uid: 1, size: 50 }, { uid: 2, size: 60 }];
        expect(await syncAccount(s2.deps as any, s2.cfg, s2.row)).toMatchObject({ stored: 2, last_uid: 2 });
    });

    it('refuses a concurrent run for the same account', async () => {
        const s = setup();
        let resolve!: () => void;
        imapState.connect = vi.fn(() => new Promise<void>(r => { resolve = r; }));
        const first = syncAccount(s.deps as any, s.cfg, s.row);
        await vi.waitFor(() => expect(imapState.connect).toHaveBeenCalled());
        expect(isRunning('acc1')).toBe(true);
        expect(await syncAccount(s.deps as any, s.cfg, s.row)).toMatchObject({ status: 'running' });
        resolve();
        expect((await first).status).toBe('ok');
        expect(isRunning('acc1')).toBe(false);
    });
});

void FakeImapFlow;
