import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import endpoint from '../../src/api/index';
import { setupEndpoint, USER } from './helpers';

vi.mock('../../src/api/imap/routes', () => ({ registerImapRoutes: vi.fn() }));

const SMTP = { EMAIL_SEND_TRANSPORT: 'smtp', EMAIL_SMTP_HOST: 'mx', EMAIL_FROM: 'noreply@corp.com' };
const RESEND = { RESEND_API_KEY: 'key', EMAIL_FROM: 'noreply@corp.com' };
const send = (t: any, body: any, acc: any = USER) => t.call('POST', '/send', { accountability: acc, body });
const basic = { to: 'x@ext.com', subject: 'S', text: 'T' };

afterEach(() => vi.unstubAllGlobals());

describe('POST /send — validation', () => {
    it('401 without user', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        expect((await send(t, basic, null)).res.statusCode).toBe(401);
    });

    it('403 when role not allowed; admins and listed roles pass', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_SEND_ALLOWED_ROLES: 'r-ok' });
        const denied = await send(t, basic);
        expect(denied.res.statusCode).toBe(403);
        expect(denied.res.body.message).toMatch(/not allowed/);
        expect((await send(t, basic, { ...USER, admin: true })).res.statusCode).toBe(200);
        expect((await send(t, basic, { ...USER, role: 'r-ok' })).res.statusCode).toBe(200);
    });

    it.each([[{}], [{ to: 'a' }], [{ to: 'a', subject: 's' }], [null]])('400 missing fields %#', async (body) => {
        const t = setupEndpoint(endpoint as any, SMTP);
        const { res } = await send(t, body);
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('missing_required_fields');
    });

    it('503 lists missing smtp settings', async () => {
        const t = setupEndpoint(endpoint as any, { EMAIL_SEND_TRANSPORT: 'smtp' });
        const { res } = await send(t, basic);
        expect(res.statusCode).toBe(503);
        expect(res.body.missing).toEqual(['EMAIL_SMTP_HOST', 'EMAIL_FROM']);
        const t2 = setupEndpoint(endpoint as any, { EMAIL_SEND_TRANSPORT: 'smtp', EMAIL_SMTP_HOST: 'h' });
        expect((await send(t2, basic)).res.body.missing).toEqual(['EMAIL_FROM']);
    });

    it('503 lists missing resend settings', async () => {
        const t = setupEndpoint(endpoint as any, {});
        const { res } = await send(t, basic);
        expect(res.body.missing).toEqual(['RESEND_API_KEY', 'EMAIL_FROM']);
        const t2 = setupEndpoint(endpoint as any, { RESEND_API_KEY: 'k' });
        expect((await send(t2, basic)).res.body.missing).toEqual(['EMAIL_FROM']);
    });

    it('400 when "to" parses to nothing', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        const { res } = await send(t, { ...basic, to: ' , ' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('invalid_to');
    });
});

describe('POST /send — smtp transport', () => {
    it('sends via MailService with alias sender, envelope, threading and attachments, then fans out', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_ATTACHMENTS_FOLDER: 'f' });
        t.col('email_aliases').readByQuery.mockResolvedValue([{ alias: 'me@corp.com', display_name: 'Me — Team' }]);
        t.col('emails').readByQuery.mockResolvedValue([{ thread_id: 'th-1' }]);
        t.col('emails').createOne.mockResolvedValue('e1');
        const opened = Readable.from([Buffer.from('xyz')]);
        t.assets.getAsset.mockResolvedValue({ stream: async () => opened, file: { filename_download: 'doc.pdf', type: 'application/pdf' }, stat: { size: 3 } });
        t.dbState.rows = [
            { id: 'u1', email: 'me@corp.com' }, // sender, skipped
            { id: 'u2', email: 'cc@corp.com' },
            { id: 'u3', email: 'dup@corp.com' },
        ];
        t.col('inbox_email').readByQuery.mockImplementation(async (q: any) => q.filter.owner._eq === 'u3' ? [{ id: 'old' }] : []);
        t.col('inbox_email').createOne.mockResolvedValue('in-2');

        const { res } = await send(t, {
            to: [{ email: 'Ext@ext.com', name: 'Ext' }, 'cc@corp.com'],
            cc: 'CC@corp.com, dup@corp.com',
            bcc: ['b@ext.com'],
            reply_to: 'r@corp.com',
            subject: 'Subj',
            html: '<p>h</p>',
            text: 't',
            in_reply_to: 'parent@corp.com',
            tenant: 'T',
            attachments: [{ filename: 'i.txt', content: Buffer.from('inline').toString('base64'), content_type: 'text/plain' }],
            attachment_ids: ['fid', 'fid', ''],
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            status: 'ok', id: 'e1', thread_id: 'th-1', provider: 'smtp', provider_message_id: '<smtp-id@x>', inbox_ids: ['in-2'],
        });
        expect(res.body.message_id).toMatch(/^<[0-9a-f-]+@corp\.com>$/);

        const opts = t.mail.send.mock.calls[0][0];
        expect(opts.from).toEqual({ name: 'Me — Team', address: 'me@corp.com' });
        expect(opts.to).toEqual([{ name: 'Ext', address: 'Ext@ext.com' }, 'cc@corp.com']);
        expect(opts.cc).toEqual(['CC@corp.com', 'dup@corp.com']);
        expect(opts.bcc).toEqual(['b@ext.com']);
        expect(opts.envelope).toEqual({ from: 'noreply@corp.com', to: ['Ext@ext.com', 'cc@corp.com', 'dup@corp.com', 'b@ext.com'] });
        expect(opts).toMatchObject({ replyTo: 'r@corp.com', html: '<p>h</p>', text: 't', inReplyTo: '<parent@corp.com>', references: '<parent@corp.com>' });
        expect(opts.attachments).toHaveLength(2);
        expect(opts.attachments[0]).toEqual({ filename: 'i.txt', content: Buffer.from('inline'), contentType: 'text/plain' });
        expect(opts.attachments[1]).toEqual({ filename: 'doc.pdf', content: opened, contentType: 'application/pdf' });
        // AssetsService honours the caller's accountability and is asked once per unique id.
        expect(t.assetsCtor[0].accountability).toBe(USER);
        expect(t.assets.getAsset).toHaveBeenCalledTimes(1);

        const created = t.col('emails').createOne.mock.calls[0][0];
        expect(created).toMatchObject({
            status: 'sending', from_address: 'me@corp.com', from_name: 'Me — Team', provider: 'smtp', owner: 'u1',
            tenant: 'T', in_reply_to: '<parent@corp.com>', thread_id: 'th-1', attachments: [{ directus_files_id: 'fid' }],
        });
        expect(t.col('emails').updateOne).toHaveBeenCalledWith('e1', expect.objectContaining({ status: 'sent', provider_message_id: '<smtp-id@x>' }));
        // Fan-out: case-insensitive lookup, To/Cc kept apart, same files linked.
        expect(t.database.raw).toHaveBeenCalledWith('lower(??)', ['email']);
        const whereIn = t.dbState.calls[0].chain.find(([m]) => m === 'whereIn')!;
        expect(whereIn[1][1]).toEqual(['ext@ext.com', 'cc@corp.com', 'dup@corp.com']);
        const mirrored = t.col('inbox_email').createOne.mock.calls[0][0];
        expect(mirrored).toMatchObject({ owner: 'u2', source: 'smtp', thread_id: 'th-1', attachments: [{ directus_files_id: 'fid' }] });
        expect(mirrored.cc_addresses).toEqual([{ email: 'CC@corp.com' }, { email: 'dup@corp.com' }]);
    });

    it('defaults: EMAIL_FROM sender, new thread, messageId fallback, minimal options', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_FROM: 'nodomain' });
        t.mail.send.mockResolvedValue(undefined);
        t.col('emails').createOne.mockResolvedValue('e1');
        const { res } = await send(t, { to: 'a@b.com', subject: 's', html: '<b>x</b>', in_reply_to: '  ' });
        expect(res.body.message_id).toMatch(/@localhost>$/);
        expect(res.body.provider_message_id).toBe(res.body.message_id);
        expect(res.body.inbox_ids).toEqual([]);
        const opts = t.mail.send.mock.calls[0][0];
        expect(opts.from).toBe('nodomain');
        for (const k of ['cc', 'bcc', 'replyTo', 'text', 'inReplyTo', 'attachments']) expect(opts).not.toHaveProperty(k);
        expect(t.col('emails').createOne.mock.calls[0][0]).toMatchObject({
            reply_to: null, body_text: null, tenant: null, is_internal: false, in_reply_to: null, attachments: [],
        });
    });

    it('uses an explicit thread_id and survives alias lookup failure; parent without thread gets a uuid', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.col('email_aliases').readByQuery.mockRejectedValue(new Error('x'));
        const a = await send(t, { ...basic, thread_id: 'given' });
        expect(a.res.body.thread_id).toBe('given');
        expect(t.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('alias lookup failed'));
        const b = await send(t, { ...basic, in_reply_to: 'p@x' });
        expect(b.res.body.thread_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('alias without display name sends plain address', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.col('email_aliases').readByQuery.mockResolvedValue([{ alias: 'me@corp.com' }]);
        await send(t, basic);
        expect(t.mail.send.mock.calls[0][0].from).toBe('me@corp.com');
    });

    it('413 when attachments exceed the limit (asset size from file metadata)', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_MAX_ATTACHMENT_BYTES: '10' });
        t.assets.getAsset.mockResolvedValue({ stream: async () => null, file: { filesize: 8, title: 'T' } });
        const { res } = await send(t, { ...basic, attachments: [{ filename: 'a', content: 'AAAAAAAA' }], attachment_ids: ['f'] });
        expect(res.statusCode).toBe(413);
        expect(res.body).toMatchObject({ error: 'attachments_too_large', bytes: 14, max_bytes: 10 });
        expect(t.col('emails').createOne).not.toHaveBeenCalled();
    });

    it('413 counts inline attachments even with no stored ids (and missing content)', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_MAX_ATTACHMENT_BYTES: '2' });
        const { res } = await send(t, { ...basic, attachments: [{ filename: 'a', content: 'AAAA' }, { filename: 'b' }] });
        expect(res.statusCode).toBe(413);
        expect(res.body.bytes).toBe(3);
    });

    it('400 when a stored attachment cannot be resolved', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.assets.getAsset.mockRejectedValue(new Error('forbidden'));
        const { res } = await send(t, { ...basic, attachment_ids: ['f'] });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('invalid_attachment');
    });

    it('asset with no metadata defaults name/type/size', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.assets.getAsset.mockResolvedValue({ stream: async () => 'S' });
        await send(t, { ...basic, attachment_ids: ['fid'] });
        expect(t.mail.send.mock.calls[0][0].attachments).toEqual([{ filename: 'fid', content: 'S', contentType: 'application/octet-stream' }]);
    });

    it('502 and marks failed on send error; bookkeeping errors are swallowed', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.col('emails').createOne.mockResolvedValue('e1');
        t.mail.send.mockRejectedValue(new Error('relay refused'));
        t.col('emails').updateOne.mockRejectedValue(new Error('no perms'));
        const { res } = await send(t, basic);
        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({ error: 'send_failed', id: 'e1', message: 'relay refused' });
        expect(t.col('emails').updateOne).toHaveBeenCalledWith('e1', { status: 'failed', error_message: 'relay refused' });
        expect(t.logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('could not mark as failed'));
    });

    it('502 with default message when the error has none', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.mail.send.mockRejectedValue({});
        const { res } = await send(t, basic);
        expect(res.body.message).toBe('The message could not be sent.');
        expect(t.col('emails').updateOne).toHaveBeenCalledWith('new-id', { status: 'failed', error_message: 'unknown' });
    });

    it('times out a stalled relay', async () => {
        const t = setupEndpoint(endpoint as any, { ...SMTP, EMAIL_SEND_TIMEOUT_MS: '20' });
        t.mail.send.mockReturnValue(new Promise(() => {}));
        const { res } = await send(t, basic);
        expect(res.statusCode).toBe(502);
        expect(res.body.message).toBe('smtp send timed out after 20ms');
    });

    it('still 200 when fan-out throws, and success bookkeeping failure is logged only', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.dbState.error = new Error('db');
        t.col('emails').updateOne.mockRejectedValue(new Error('perm'));
        const { res } = await send(t, basic);
        expect(res.statusCode).toBe(200);
        expect(res.body.inbox_ids).toEqual([]);
        expect(t.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('fan-out failed'));
        expect(t.logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('could not mark as sent'));
    });

    it('fan-out skips when no users match or addresses are empty', async () => {
        const t = setupEndpoint(endpoint as any, SMTP);
        t.dbState.rows = [];
        expect((await send(t, basic)).res.body.inbox_ids).toEqual([]);
        expect(t.col('inbox_email').createOne).not.toHaveBeenCalled();
        const t2 = setupEndpoint(endpoint as any, SMTP);
        await send(t2, { ...basic, to: [{ email: '' }] });
        expect(t2.database).not.toHaveBeenCalled();
    });
});

describe('POST /send — resend transport', () => {
    it('posts to Resend with formatted addresses, headers and base64 attachments', async () => {
        const t = setupEndpoint(endpoint as any, RESEND);
        t.col('email_aliases').readByQuery.mockResolvedValue([{ alias: 'me@corp.com', display_name: 'Me' }]);
        t.assets.getAsset.mockResolvedValue({ stream: async () => Readable.from([Buffer.from('ab'), Buffer.from('c')]), file: { filename_download: 'f.txt', type: 'text/plain' } });
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'rs-1' }) }));
        vi.stubGlobal('fetch', fetchMock);
        const { res } = await send(t, {
            to: [{ email: 'a@x.com', name: 'A' }], cc: 'c@x.com', bcc: 'b@x.com', reply_to: 'r@x.com',
            subject: 'S', html: '<p>h</p>', text: 't', in_reply_to: '<p@x>',
            attachments: [{ filename: 'i', content: 'QQ==', content_type: 'text/plain' }], attachment_ids: ['fid'],
        });
        expect(res.body).toMatchObject({ provider: 'resend', provider_message_id: 'rs-1' });
        const [url, init] = fetchMock.mock.calls[0] as any;
        expect(url).toBe('https://api.resend.com/emails');
        expect(init.headers.Authorization).toBe('Bearer key');
        const p = JSON.parse(init.body);
        expect(p).toMatchObject({
            from: 'Me <me@corp.com>', to: ['A <a@x.com>'], cc: ['c@x.com'], bcc: ['b@x.com'], reply_to: 'r@x.com',
            html: '<p>h</p>', text: 't',
            headers: { 'In-Reply-To': '<p@x>', References: '<p@x>' },
            attachments: [
                { filename: 'i', content: 'QQ==', content_type: 'text/plain' },
                { filename: 'f.txt', content: Buffer.from('abc').toString('base64'), content_type: 'text/plain' },
            ],
        });
        expect(p.headers['Message-ID']).toBe(res.body.message_id);
        expect(t.col('emails').createOne.mock.calls[0][0].provider).toBe('resend');
    });

    it('minimal payload and null provider id', async () => {
        const t = setupEndpoint(endpoint as any, RESEND);
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
        vi.stubGlobal('fetch', fetchMock);
        const { res } = await send(t, { to: 'a@x.com', subject: 'S', text: 't', in_reply_to: ' ' });
        expect(res.body.provider_message_id).toBeNull();
        const p = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
        expect(p.from).toBe('noreply@corp.com');
        for (const k of ['cc', 'bcc', 'reply_to', 'html', 'attachments']) expect(p).not.toHaveProperty(k);
        expect(Object.keys(p.headers)).toEqual(['Message-ID']);
    });

    it('502 with Resend status and truncated body on HTTP error', async () => {
        const t = setupEndpoint(endpoint as any, RESEND);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, text: async () => 'x'.repeat(600) })));
        const { res } = await send(t, basic);
        expect(res.statusCode).toBe(502);
        expect(res.body.message).toBe(`Resend 422: ${'x'.repeat(500)}`);
    });
});

describe('POST /internal/send', () => {
    const isend = (t: any, body: any, acc: any = USER) => t.call('POST', '/internal/send', { accountability: acc, body });

    it('401 / 400 validation', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await isend(t, {}, null)).res.statusCode).toBe(401);
        for (const b of [null, { to_user: 'x' }, { to_user: 'x', subject: 's' }]) {
            expect((await isend(t, b)).res.body.error).toBe('missing_required_fields');
        }
        expect((await isend(t, { to_user: [], subject: 's', body_text: 't' })).res.body.error).toBe('invalid_to_user');
    });

    it('400 when a recipient is unknown', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readMany.mockResolvedValue([]);
        const { res } = await isend(t, { to_user: 'u2', subject: 's', body_text: 't' });
        expect(res.body).toEqual({ error: 'unknown_recipient' });
    });

    it('writes one sent row and one inbox row per recipient, threaded by inbox parent', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readMany.mockResolvedValue([
            { id: 'u2', email: 'b@x', first_name: 'B', last_name: 'Bee' },
            { id: 'u3', email: 'c@x' },
        ]);
        t.col('directus_users').readOne.mockResolvedValue({ id: 'u1', email: 'me@x', first_name: 'Me' });
        t.col('inbox_email').readByQuery.mockResolvedValue([{ thread_id: 'th-in' }]);
        t.col('emails').readByQuery.mockResolvedValue([{ thread_id: 'th-sent' }]);
        t.col('emails').createOne.mockResolvedValue('s1');
        t.col('inbox_email').createOne.mockResolvedValueOnce('i2').mockResolvedValueOnce('i3');
        const { res } = await isend(t, { to_user: ['u2', 'u3'], subject: 'S', body_html: '<p>', in_reply_to: 'p@x', tenant: 'T', attachment_ids: ['f1'] });
        expect(res.body).toMatchObject({ status: 'ok', sent_id: 's1', inbox_ids: ['i2', 'i3'], thread_id: 'th-in' });
        expect(res.body.message_id).toMatch(/@internal\.local>$/);
        const sent = t.col('emails').createOne.mock.calls[0][0];
        expect(sent).toMatchObject({
            provider: 'internal', from_address: 'me@x', from_name: 'Me', owner: 'u1', tenant: 'T', in_reply_to: '<p@x>',
            body_html: '<p>', body_text: null, attachments: [{ directus_files_id: 'f1' }],
            to_addresses: [{ email: 'b@x', name: 'B Bee', user_id: 'u2' }, { email: 'c@x', name: undefined, user_id: 'u3' }],
        });
        const inboxRows = t.col('inbox_email').createOne.mock.calls.map(c => c[0]);
        expect(inboxRows.map(r => r.owner)).toEqual(['u2', 'u3']);
        expect(inboxRows[0]).toMatchObject({ source: 'internal', from_user: 'u1', is_read: false, attachments: [{ directus_files_id: 'f1' }] });
    });

    it('falls back to sent-parent thread, then to sender id address', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readMany.mockResolvedValue([{ id: 'u2', email: 'b@x' }]);
        t.col('directus_users').readOne.mockResolvedValue(null);
        t.col('emails').readByQuery.mockResolvedValue([{ thread_id: 'th-sent' }]);
        const { res } = await isend(t, { to_user: 'u2', subject: 'S', body_text: 't', in_reply_to: 'p@x' });
        expect(res.body.thread_id).toBe('th-sent');
        expect(t.col('emails').createOne.mock.calls[0][0]).toMatchObject({ from_address: 'u1@internal.local', from_name: null, tenant: null, attachments: [] });
    });

    it('explicit thread_id wins; sender name falls back to email; no parent -> uuid', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readMany.mockResolvedValue([{ id: 'u2', email: 'b@x' }]);
        t.col('directus_users').readOne.mockResolvedValue({ email: 'me@x' });
        const a = await isend(t, { to_user: 'u2', subject: 'S', body_text: 't', thread_id: 'given' });
        expect(a.res.body.thread_id).toBe('given');
        expect(t.col('emails').createOne.mock.calls[0][0].from_name).toBe('me@x');
        const b = await isend(t, { to_user: 'u2', subject: 'S', body_text: 't', in_reply_to: 'p@x' });
        expect(b.res.body.thread_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('500 on failure', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readMany.mockRejectedValue(new Error('db'));
        const { res } = await isend(t, { to_user: 'u2', subject: 'S', body_text: 't' });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('db');
    });
});
