import { describe, expect, it, vi } from 'vitest';
import endpoint from '../../src/api/index';
import { setupEndpoint } from './helpers';

vi.mock('../../src/api/imap/routes', () => ({ registerImapRoutes: vi.fn() }));

const ENV = { EMAIL_INBOUND_USER: 'hook', EMAIL_INBOUND_PASS: 's3cret' };
const auth = (u = 'hook', p = 's3cret') => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const PATH = '/inbound/postmark';

function payload(extra: any = {}) {
    return { MessageID: 'pm-1', From: 'ext@out.com', To: 'me@ours.com', Subject: 'Hi', TextBody: 'body', ...extra };
}

describe('POST /inbound/postmark — gatekeeping', () => {
    it('503 when credentials are not configured', async () => {
        const t = setupEndpoint(endpoint as any, {});
        const { res } = await t.call('POST', PATH, { body: payload() });
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: 'service_unconfigured' });
    });

    it.each([
        ['no header', undefined],
        ['non-basic', 'Bearer x'],
        ['non-string', 123],
        ['no colon', `Basic ${Buffer.from('nocolon').toString('base64')}`],
        ['wrong user length', auth('h', 's3cret')],
        ['wrong password', auth('hook', 's3creT')],
    ])('401 on bad auth: %s', async (_n, header) => {
        const t = setupEndpoint(endpoint as any, ENV);
        const { res } = await t.call('POST', PATH, {
            headers: header === undefined ? {} : { authorization: header },
            socket: { remoteAddress: '9.9.9.9' },
            body: payload(),
        });
        expect(res.statusCode).toBe(401);
        expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad basic auth'));
    });

    it('401 when the auth header decode throws', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => { throw new Error('decode'); });
        const { res } = await t.call('POST', PATH, { headers: { authorization: 'Basic zzz' }, body: payload() });
        spy.mockRestore();
        expect(res.statusCode).toBe(401);
    });

    it('403 when IP is not on the allowlist (x-forwarded-for first hop)', async () => {
        const t = setupEndpoint(endpoint as any, { ...ENV, EMAIL_INBOUND_ALLOWED_IPS: '10.0.0.1, .example.net' });
        const { res } = await t.call('POST', PATH, {
            headers: { authorization: auth(), 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
            body: payload(),
        });
        expect(res.statusCode).toBe(403);
        expect(t.logger.warn).toHaveBeenCalledWith('email-inbound: rejected IP 1.2.3.4');
    });

    it('accepts allowlisted IPs by exact match or suffix, from req.ip too', async () => {
        const t = setupEndpoint(endpoint as any, { ...ENV, EMAIL_INBOUND_ALLOWED_IPS: ['10.0.0.1', 'example.net'] });
        let r = await t.call('POST', PATH, { headers: { authorization: auth() }, ip: '10.0.0.1', body: payload() });
        expect(r.res.statusCode).toBe(200);
        r = await t.call('POST', PATH, { headers: { authorization: auth() }, socket: { remoteAddress: 'mx.example.net' }, body: payload({ MessageID: 'pm-2' }) });
        expect(r.res.statusCode).toBe(200);
        r = await t.call('POST', PATH, { headers: { authorization: auth() }, body: payload({ MessageID: 'pm-3' }) });
        expect(r.res.statusCode).toBe(403);
    });

    it('non-string allowlist value is treated as a single entry', async () => {
        const t = setupEndpoint(endpoint as any, { ...ENV, EMAIL_INBOUND_ALLOWED_IPS: 42 });
        const r = await t.call('POST', PATH, { headers: { authorization: auth() }, ip: '42', body: payload() });
        expect(r.res.statusCode).toBe(200);
    });

    it.each([[null], [{ From: 'x' }], [{ MessageID: 'x' }]])('400 on invalid payload %#', async (body) => {
        const t = setupEndpoint(endpoint as any, ENV);
        const { res } = await t.call('POST', PATH, { headers: { authorization: auth() }, body });
        expect(res.statusCode).toBe(400);
    });
});

describe('POST /inbound/postmark — storage', () => {
    const go = (t: any, body: any) => t.call('POST', PATH, { headers: { authorization: auth() }, body });

    it('short-circuits duplicates by provider message id', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('inbox_email').readByQuery.mockResolvedValueOnce([{ id: 'old' }]);
        const { res } = await go(t, payload());
        expect(res.body).toEqual({ status: 'duplicate', id: 'old' });
        expect(t.col('inbox_email').createOne).not.toHaveBeenCalled();
    });

    it('stores one unowned row when nothing matches, with defaults', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('inbox_email').createOne.mockResolvedValue('row-1');
        const { res } = await go(t, { MessageID: 'pm-1', From: 'ext@out.com', To: '' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'ok', id: 'row-1', ids: ['row-1'], thread_id: expect.any(String) });
        const row = t.col('inbox_email').createOne.mock.calls[0][0];
        expect(row).toMatchObject({
            source: 'postmark', owner: null, tenant: null, from_name: null, subject: '(no subject)',
            body_html: null, body_text: null, reply_to: null, message_id: '<pm-1>', in_reply_to: null,
            references_header: null, provider_message_id: 'pm-1', attachments: [], cc_addresses: [],
            to_addresses: [{ email: '', name: undefined }],
        });
        expect(t.logger.info).toHaveBeenCalledWith(expect.stringContaining('owner=(unassigned)'));
    });

    it('fans out to every matched owner (exact and wildcard aliases), ignoring unowned aliases', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        const aliases = t.col('email_aliases');
        aliases.readByQuery.mockImplementation(async (q: any) => {
            const a = q.filter.alias._eq;
            if (a === 'orig@ours.com') return [{ owner: 'u-a', tenant: 'T1' }];
            if (a === 'b@ours.com') return [{ owner: 'u-b', tenant: null }];
            if (a === '*@team.com') return [{ owner: null, tenant: 'T2' }];
            return [];
        });
        t.col('inbox_email').createOne.mockResolvedValueOnce('ra').mockResolvedValueOnce('rb');
        const { res } = await go(t, payload({
            OriginalRecipient: 'ORIG@ours.com',
            ToFull: [{ Email: 'b@ours.com', Name: 'B' }, { Email: 'noat' }],
            To: 'b@ours.com',
            CcFull: [{ Email: 'shared@team.com' }],
            Cc: 'shared@team.com',
            FromFull: { Email: 'ext@out.com', Name: 'Ext' },
            ReplyTo: 'r@out.com',
            HtmlBody: '<p>x</p>',
            Date: '2024-05-01T10:00:00Z',
        }));
        expect(res.body.ids).toEqual(['ra', 'rb']);
        const calls = t.col('inbox_email').createOne.mock.calls.map(c => c[0]);
        expect(calls.map(c => [c.owner, c.tenant])).toEqual([['u-a', 'T1'], ['u-b', null]]);
        expect(calls[0]).toMatchObject({
            from_name: 'Ext', reply_to: 'r@out.com', body_html: '<p>x</p>',
            received_at: '2024-05-01T10:00:00.000Z',
            to_addresses: [{ email: 'b@ours.com', name: 'B' }, { email: 'noat', name: undefined }],
            cc_addresses: [{ email: 'shared@team.com', name: undefined }],
        });
        // Wildcard lookup used the candidate's domain; "noat" has no domain -> no wildcard query.
        const queried = aliases.readByQuery.mock.calls.map(c => c[0].filter.alias._eq);
        expect(queried).toContain('*@team.com');
        expect(queried).not.toContain('*@undefined');
    });

    it('uses the first matched tenant for an unowned row', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('email_aliases').readByQuery.mockImplementation(async (q: any) =>
            q.filter.alias._eq === 'me@ours.com' ? [{ owner: null, tenant: 'T9' }] : []);
        await go(t, payload());
        expect(t.col('inbox_email').createOne.mock.calls[0][0]).toMatchObject({ owner: null, tenant: 'T9' });
    });

    it('threads via inbox parent from In-Reply-To / References headers', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        const inbox = t.col('inbox_email');
        inbox.readByQuery
            .mockResolvedValueOnce([]) // dedupe
            .mockResolvedValueOnce([{ thread_id: 'th-in' }]); // parent
        const { res } = await go(t, payload({
            Headers: [
                { Name: 'message-id', Value: ' <<abc@x>> ' },
                { Name: 'In-Reply-To', Value: 'parent@x' },
                { Name: 'References', Value: ' <r1@x>   <r2@x> ' },
            ],
        }));
        expect(res.body.thread_id).toBe('th-in');
        expect(inbox.readByQuery.mock.calls[1][0].filter).toEqual({ message_id: { _in: ['<parent@x>', '<r1@x>', '<r2@x>'] } });
        expect(inbox.createOne.mock.calls[0][0]).toMatchObject({
            message_id: '<abc@x>', in_reply_to: '<parent@x>', references_header: '<r1@x> <r2@x>',
        });
    });

    it('threads via sent parent when inbox has none; else new uuid', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('emails').readByQuery.mockResolvedValueOnce([{ thread_id: 'th-sent' }]).mockResolvedValueOnce([{}]);
        const hdr = { Headers: [{ Name: 'In-Reply-To', Value: '   ' }, { Name: 'References', Value: '<p@x>' }] };
        const a = await go(t, payload(hdr));
        expect(a.res.body.thread_id).toBe('th-sent');
        const b = await go(t, payload({ ...hdr, MessageID: 'pm-2' }));
        expect(b.res.body.thread_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('uploads attachments into the folder and storage, continuing past failures', async () => {
        const t = setupEndpoint(endpoint as any, { ...ENV, EMAIL_ATTACHMENTS_FOLDER: 'fold', STORAGE_LOCATIONS: 's3,local' });
        t.files.uploadOne.mockResolvedValueOnce('f-ok').mockRejectedValueOnce(new Error('disk'));
        await go(t, payload({
            Attachments: [
                { Name: 'a.txt', Content: Buffer.from('hello').toString('base64'), ContentType: 'text/plain', ContentLength: 5 },
                { Name: 'b.bin', Content: 'AAAA', ContentType: 'application/octet-stream', ContentLength: 3 },
            ],
        }));
        expect(t.files.uploadOne.mock.calls[0][1]).toEqual({
            filename_download: 'a.txt', type: 'text/plain', storage: 's3', title: 'a.txt', filesize: 5, folder: 'fold',
        });
        expect(t.logger.error).toHaveBeenCalledWith(expect.objectContaining({ filename: 'b.bin' }), expect.any(String));
        expect(t.col('inbox_email').createOne.mock.calls[0][0].attachments).toEqual([{ directus_files_id: 'f-ok' }]);
    });

    it('uploads without folder to local storage by default', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        await go(t, payload({ Attachments: [{ Name: 'a', Content: 'QQ==', ContentType: 't', ContentLength: 1 }] }));
        const meta = t.files.uploadOne.mock.calls[0][1];
        expect(meta.storage).toBe('local');
        expect(meta).not.toHaveProperty('folder');
    });

    it('reuses an already-mirrored row for an owner', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('email_aliases').readByQuery.mockImplementation(async (q: any) =>
            q.filter.alias._eq === 'me@ours.com' ? [{ owner: 'u1' }] : []);
        t.col('inbox_email').readByQuery
            .mockResolvedValueOnce([]) // provider dedupe
            .mockResolvedValueOnce([{ id: 'mirror' }]); // message-id + owner
        const { res } = await go(t, payload());
        expect(res.body.ids).toEqual(['mirror']);
        expect(t.col('inbox_email').createOne).not.toHaveBeenCalled();
    });

    it('500 on storage failure (unknown message fallback)', async () => {
        const t = setupEndpoint(endpoint as any, ENV);
        t.col('inbox_email').readByQuery.mockRejectedValueOnce({});
        const { res } = await go(t, payload());
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'internal_error', message: 'unknown' });
    });
});
