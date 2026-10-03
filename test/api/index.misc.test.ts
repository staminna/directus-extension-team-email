import { describe, expect, it, vi } from 'vitest';
import { registerImapRoutes } from '../../src/api/imap/routes';
import endpoint from '../../src/api/index';
import { setupEndpoint, USER } from './helpers';

vi.mock('../../src/api/imap/routes', () => ({ registerImapRoutes: vi.fn() }));

describe('endpoint registration', () => {
    it('has id "email", registers every route and the IMAP sub-routes', () => {
        const t = setupEndpoint(endpoint as any);
        expect((endpoint as any).id).toBe('email');
        expect([...t.routes.keys()].sort()).toEqual([
            'DELETE /inbox/:id', 'DELETE /sent/:id',
            'GET /config', 'GET /health', 'GET /message/:id/attachment/:fileId', 'GET /message/:id/attachments',
            'GET /message/:id/body', 'GET /recipients', 'GET /threads/:id',
            'POST /inbound/postmark', 'POST /inbox/:id/read', 'POST /inbox/:id/unread',
            'POST /internal/send', 'POST /send',
        ]);
        expect(registerImapRoutes).toHaveBeenCalledWith(t.router, expect.objectContaining({ database: t.database }));
    });
});

describe('GET /config', () => {
    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        const { res } = await t.call('GET', '/config', {});
        expect(res.statusCode).toBe(401);
    });
    it('returns defaults', async () => {
        const t = setupEndpoint(endpoint as any);
        const { res } = await t.call('GET', '/config', { accountability: USER });
        expect(res.body).toEqual({ attachments_folder: null, max_attachment_bytes: 26_214_400 });
    });
    it('returns configured folder and limit, falling back on a bad limit', async () => {
        let t = setupEndpoint(endpoint as any, { EMAIL_ATTACHMENTS_FOLDER: 'fold', EMAIL_MAX_ATTACHMENT_BYTES: '1000' });
        expect((await t.call('GET', '/config', { accountability: USER })).res.body)
            .toEqual({ attachments_folder: 'fold', max_attachment_bytes: 1000 });
        t = setupEndpoint(endpoint as any, { EMAIL_MAX_ATTACHMENT_BYTES: 'nope' });
        expect((await t.call('GET', '/config', { accountability: USER })).res.body.max_attachment_bytes).toBe(26_214_400);
    });
});

describe('GET /health', () => {
    it('reports resend transport by default', async () => {
        const t = setupEndpoint(endpoint as any, { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b' });
        const { res } = await t.call('GET', '/health');
        expect(res.body).toEqual({ ok: true, inbound: false, send: true, send_transport: 'resend' });
    });
    it('reports smtp transport and inbound config', async () => {
        const t = setupEndpoint(endpoint as any, {
            EMAIL_SEND_TRANSPORT: ' SMTP ', EMAIL_INBOUND_USER: 'u', EMAIL_INBOUND_PASS: 'p', EMAIL_FROM: 'a@b',
        });
        const { res } = await t.call('GET', '/health');
        expect(res.body).toEqual({ ok: true, inbound: true, send: false, send_transport: 'smtp' });
    });
});

describe('GET /recipients', () => {
    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await t.call('GET', '/recipients')).res.statusCode).toBe(401);
    });
    it('lists active users with an email, system-level', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readByQuery.mockResolvedValue([{ id: '1', email: 'a@x' }, { id: '2', email: null }]);
        const { res } = await t.call('GET', '/recipients', { accountability: USER });
        expect(res.body).toEqual({ data: [{ id: '1', email: 'a@x' }] });
        const ctor = t.ctorCalls.find(c => c.collection === 'directus_users')!;
        expect(ctor.opts.accountability).toBeUndefined();
        expect(t.col('directus_users').readByQuery).toHaveBeenCalledWith(expect.objectContaining({
            filter: { status: { _eq: 'active' } }, limit: 500,
        }));
    });
    it('handles a null result', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readByQuery.mockResolvedValue(null as any);
        expect((await t.call('GET', '/recipients', { accountability: USER })).res.body).toEqual({ data: [] });
    });
    it('returns 500 on failure', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('directus_users').readByQuery.mockRejectedValue(new Error('boom'));
        const { res } = await t.call('GET', '/recipients', { accountability: USER });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'internal_error', message: 'boom' });
        expect(t.logger.error).toHaveBeenCalled();
    });
});

describe('GET /message/:id/body', () => {
    const req = (extra: any = {}) => ({ accountability: USER, params: { id: 'm1' }, query: {}, ...extra });

    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        const { res } = await t.call('GET', '/message/:id/body', { params: { id: 'm1' } });
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('');
    });

    it('renders text bodies escaped inside <pre> with a mail CSP', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ body_html: null, body_text: 'a < b & c > d' });
        const { res } = await t.call('GET', '/message/:id/body', req());
        expect(res.body).toContain('<pre>a &lt; b &amp; c &gt; d</pre>');
        expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
        expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
        expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
        expect(res.headers['Referrer-Policy']).toBe('no-referrer');
        // Read with the caller's accountability.
        const ctor = t.ctorCalls.find(c => c.collection === 'inbox_email')!;
        expect(ctor.opts.accountability).toBe(USER);
    });

    it('renders an empty <pre> when the row has no body', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readOne.mockResolvedValue(null);
        const { res } = await t.call('GET', '/message/:id/body', req({ query: { kind: 'sent' } }));
        expect(res.body).toContain('<body><pre></pre></body>');
        expect(t.col('emails').readOne).toHaveBeenCalledWith('m1', { fields: ['body_html', 'body_text'] });
    });

    it('strips active content and makes images eager', async () => {
        const t = setupEndpoint(endpoint as any);
        const html = [
            '<p onclick="evil()" class="x">hi</p>',
            '<img src="a.png" loading="lazy" alt="someone online=1" onerror=alert(1)>',
            "<img src='b.png' loading='lazy'>",
            '<script>alert(1)</script>',
            '<script src="x.js">',
            '<iframe src="x"></iframe>',
            '<object data="x"></object>',
            '<embed src="y">',
            '<base href="http://evil">',
            '<link rel="stylesheet" href="s.css">',
            '<meta http-equiv="refresh" content="0;url=x">',
            '<style>@import url(evil.css); p{color:red}</style>',
            '<a href="javascript:alert(1)">x</a>',
            '<form action=\'javascript:go()\'></form>',
        ].join('');
        t.col('inbox_email').readOne.mockResolvedValue({ body_html: html });
        const { res } = await t.call('GET', '/message/:id/body', req());
        const out: string = res.body;
        expect(out).not.toMatch(/onclick|onerror|<script|<iframe|<object|<embed|<base|<link|http-equiv|@import|javascript:/i);
        expect(out).toContain('<p class="x">hi</p>');
        expect(out).toContain('alt="someone online=1"');
        expect(out).toContain('loading="eager"');
        expect(out).toContain("loading='eager'");
        expect(out).toContain('<a href="#">x</a>');
        expect(out).toContain('p{color:red}');
    });

    it('returns 404 when the row is not readable', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockRejectedValue(new Error('forbidden'));
        const { res } = await t.call('GET', '/message/:id/body', req());
        expect(res.statusCode).toBe(404);
        expect(t.logger.warn).toHaveBeenCalled();
    });
});

describe('attachments', () => {
    const LIST = 'GET /message/:id/attachments';
    const ONE = 'GET /message/:id/attachment/:fileId';
    const [lm, lp] = LIST.split(' ');
    const [om, op] = ONE.split(' ');

    it('list: 401 without user', async () => {
        const t = setupEndpoint(endpoint as any);
        const { res } = await t.call(lm, lp, { params: { id: 'm' } });
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: 'not_found' });
    });

    it('list: 404 when parent unreadable or missing', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockRejectedValueOnce(new Error('no'));
        expect((await t.call(lm, lp, { accountability: USER, params: { id: 'm' } })).res.statusCode).toBe(404);
        t.col('inbox_email').readOne.mockResolvedValueOnce(null);
        expect((await t.call(lm, lp, { accountability: USER, params: { id: 'm' } })).res.statusCode).toBe(404);
        expect(t.col('inbox_email').readOne).toHaveBeenCalledWith('m', {
            fields: ['id', 'owner', 'source', 'attachments.directus_files_id'],
        });
    });

    it('list: empty when the message has no attachments (sent kind)', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readOne.mockResolvedValue({ id: 'm' });
        const { res } = await t.call(lm, lp, { accountability: USER, params: { id: 'm' }, query: { kind: 'sent' } });
        expect(res.body).toEqual({ data: [], shared: false });
        expect(t.col('emails').readOne).toHaveBeenCalledWith('m', { fields: ['id', 'attachments.directus_files_id'] });
    });

    it('list: 403 on shared mailbox for a role that is not allowed', async () => {
        const t = setupEndpoint(endpoint as any);
        t.dbState.rows = [{ id: 'admin-role' }];
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: null, source: 'postmark', attachments: [] });
        const { res } = await t.call(lm, lp, { accountability: USER, params: { id: 'm' } });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden' });
    });

    it('list: returns file metadata in attachment order for allowed shared access', async () => {
        const t = setupEndpoint(endpoint as any);
        t.dbState.rows = [{ id: 'r1' }];
        t.col('inbox_email').readOne.mockResolvedValue({
            id: 'm', owner: null, source: 'postmark',
            attachments: [{ directus_files_id: { id: 'f2' } }, { directus_files_id: 'f1' }, { directus_files_id: 'f3' }, null],
        });
        t.files.readMany.mockResolvedValue([
            { id: 'f1', filename_download: 'a.pdf', type: 'application/pdf', filesize: '10' },
            { id: 'f2', title: 'T', type: null, filesize: null },
        ]);
        const { res } = await t.call(lm, lp, { accountability: USER, params: { id: 'm' } });
        expect(res.body).toEqual({
            shared: true,
            data: [
                { id: 'f2', filename: 'T', type: 'application/octet-stream', filesize: null },
                { id: 'f1', filename: 'a.pdf', type: 'application/pdf', filesize: 10 },
            ],
        });
        expect(t.files.readMany).toHaveBeenCalledWith(['f2', 'f1', 'f3'], expect.anything());
        expect(t.filesCtor[0].accountability).toBeNull();
        expect(res.headers['Cache-Control']).toBe('private, no-store');
    });

    it('list: falls back to "attachment" filename and 500 on failure', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: 'u1', source: 'smtp', attachments: [{ directus_files_id: 'f1' }] });
        t.files.readMany.mockResolvedValueOnce([{ id: 'f1' }]);
        expect((await t.call(lm, lp, { accountability: USER, params: { id: 'm' } })).res.body.data[0].filename).toBe('attachment');
        t.files.readMany.mockRejectedValueOnce(new Error('x'));
        const { res } = await t.call(lm, lp, { accountability: USER, params: { id: 'm' } });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'internal' });
    });

    function fakeStream() {
        const handlers: Record<string, any> = {};
        return { handlers, on: vi.fn((ev: string, fn: any) => { handlers[ev] = fn; }), pipe: vi.fn((r: any) => r) };
    }

    it('download: auth failure and file not attached give empty statuses', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await t.call(om, op, { params: { id: 'm', fileId: 'f' } })).res.statusCode).toBe(401);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: 'u1', attachments: [{ directus_files_id: 'f1' }] });
        const { res } = await t.call(om, op, { accountability: USER, params: { id: 'm', fileId: 'other' } });
        expect(res.statusCode).toBe(404);
        expect(t.assets.getAsset).not.toHaveBeenCalled();
    });

    it('download: streams inline-safe file inline with RFC 5987 filename', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: 'u1', attachments: [{ directus_files_id: 'f1' }] });
        const stream = fakeStream();
        t.assets.getAsset.mockResolvedValue({ stream, file: { type: 'application/PDF', filename_download: 'orçamento "1"\n.pdf', filesize: 42 } });
        const { res } = await t.call(om, op, { accountability: USER, params: { id: 'm', fileId: 'f1' }, query: { inline: '1' } });
        expect(t.assets.getAsset).toHaveBeenCalledWith('f1', null, undefined, false);
        expect(t.assetsCtor[0].accountability).toBeNull();
        expect(res.headers['Content-Type']).toBe('application/PDF');
        expect(res.headers['Content-Disposition']).toBe(
            `inline; filename="orcamento _1_ .pdf"; filename*=UTF-8''${encodeURIComponent('orçamento "1" .pdf')}`,
        );
        expect(res.headers['Content-Length']).toBe('42');
        expect(stream.pipe).toHaveBeenCalledWith(res);
        // Stream errors destroy the response.
        stream.handlers.error(new Error('io'));
        expect(res.destroy).toHaveBeenCalled();
        expect(t.logger.warn).toHaveBeenCalled();
    });

    it('download: unsafe types and missing metadata are attachments with defaults', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readOne.mockResolvedValue({ id: 'm', attachments: [{ directus_files_id: 'f1' }] });
        const stream = fakeStream();
        t.assets.getAsset.mockResolvedValue({ stream, file: null });
        const { res } = await t.call(om, op, { accountability: USER, params: { id: 'm', fileId: 'f1' }, query: { kind: 'sent', inline: '1' } });
        expect(res.headers['Content-Type']).toBe('application/octet-stream');
        expect(res.headers['Content-Disposition']).toBe(`attachment; filename="attachment"; filename*=UTF-8''attachment`);
        expect(res.headers['Content-Length']).toBeUndefined();
    });

    it('download: non-ascii-only names fall back to "attachment"; title used; svg not inline', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: 'u1', attachments: [{ directus_files_id: 'f1' }] });
        t.assets.getAsset.mockResolvedValue({ stream: fakeStream(), file: { type: 'image/svg+xml', title: '日本' } });
        const { res } = await t.call(om, op, { accountability: USER, params: { id: 'm', fileId: 'f1' }, query: { inline: '1' } });
        expect(res.headers['Content-Disposition']).toMatch(/^attachment; filename="attachment"; filename\*=UTF-8''%E6/);
    });

    it('download: 404 when the asset cannot be read', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'm', owner: 'u1', attachments: [{ directus_files_id: 'f1' }] });
        t.assets.getAsset.mockRejectedValue(new Error('gone'));
        const { res } = await t.call(om, op, { accountability: USER, params: { id: 'm', fileId: 'f1' } });
        expect(res.statusCode).toBe(404);
    });
});

describe('GET /threads/:id', () => {
    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await t.call('GET', '/threads/:id', { params: { id: 't' } })).res.statusCode).toBe(401);
    });

    it('merges sent and received sorted by date, hydrating attachments', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readByQuery.mockResolvedValue([
            { id: 's1', date_created: '2024-01-02T00:00:00Z', attachments: [{ directus_files_id: 'f1' }, { directus_files_id: 'gone' }] },
        ]);
        t.col('inbox_email').readByQuery.mockResolvedValue([
            { id: 'r1', date_created: '2024-01-01T00:00:00Z', attachments: [{ directus_files_id: { id: 'f1' } }] },
            { id: 'r2' },
        ]);
        t.col('directus_files').readByQuery.mockResolvedValue([{ id: 'f1', filename_download: 'a.txt' }]);
        const { res } = await t.call('GET', '/threads/:id', { accountability: USER, params: { id: 't' } });
        expect(res.body.thread_id).toBe('t');
        expect(res.body.items.map((i: any) => [i.id, i._kind])).toEqual([['r2', 'received'], ['r1', 'received'], ['s1', 'sent']]);
        const s1 = res.body.items.find((i: any) => i.id === 's1');
        expect(s1.attachments).toEqual([{ directus_files_id: { id: 'f1', filename_download: 'a.txt' } }]);
        expect(res.body.items.find((i: any) => i.id === 'r2').attachments).toEqual([]);
        expect(t.col('directus_files').readByQuery).toHaveBeenCalledWith(expect.objectContaining({ filter: { id: { _in: ['f1', 'gone'] } } }));
    });

    it('skips file lookup when there are no attachments, and 500s on error', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readByQuery.mockResolvedValue([{ id: 's1' }]);
        t.col('inbox_email').readByQuery.mockResolvedValue([]);
        const ok = await t.call('GET', '/threads/:id', { accountability: USER, params: { id: 't' } });
        expect(ok.res.body.items).toHaveLength(1);
        expect(t.col('directus_files').readByQuery).not.toHaveBeenCalled();

        t.col('emails').readByQuery.mockRejectedValue(new Error('bad'));
        const { res } = await t.call('GET', '/threads/:id', { accountability: USER, params: { id: 't' } });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('bad');
    });
});

describe('POST /inbox/:id/read|unread', () => {
    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await t.call('POST', '/inbox/:id/read', { params: { id: 'x' } })).res.statusCode).toBe(401);
    });
    it('marks read with a timestamp and unread with null', async () => {
        const t = setupEndpoint(endpoint as any);
        const r1 = await t.call('POST', '/inbox/:id/read', { accountability: USER, params: { id: 'x' } });
        expect(r1.res.body).toEqual({ status: 'ok', id: 'x', is_read: true });
        expect(t.col('inbox_email').updateOne).toHaveBeenCalledWith('x', { is_read: true, read_at: expect.any(String) });
        const r2 = await t.call('POST', '/inbox/:id/unread', { accountability: USER, params: { id: 'x' } });
        expect(r2.res.body.is_read).toBe(false);
        expect(t.col('inbox_email').updateOne).toHaveBeenLastCalledWith('x', { is_read: false, read_at: null });
    });
    it('500 on failure', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').updateOne.mockRejectedValue(new Error('denied'));
        const { res } = await t.call('POST', '/inbox/:id/read', { accountability: USER, params: { id: 'x' } });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('denied');
    });
});

describe('DELETE /inbox/:id and /sent/:id', () => {
    it('requires a user', async () => {
        const t = setupEndpoint(endpoint as any);
        expect((await t.call('DELETE', '/inbox/:id', { params: { id: 'x' } })).res.statusCode).toBe(401);
    });
    it('404 when unreadable, 403 when not owner or missing', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockRejectedValueOnce(new Error('x'));
        expect((await t.call('DELETE', '/inbox/:id', { accountability: USER, params: { id: 'x' } })).res.statusCode).toBe(404);
        t.col('inbox_email').readOne.mockResolvedValueOnce({ id: 'x', owner: 'someone' });
        expect((await t.call('DELETE', '/inbox/:id', { accountability: USER, params: { id: 'x' } })).res.statusCode).toBe(403);
        t.col('inbox_email').readOne.mockResolvedValueOnce(null);
        expect((await t.call('DELETE', '/inbox/:id', { accountability: USER, params: { id: 'x' } })).res.statusCode).toBe(403);
        expect(t.col('inbox_email').deleteOne).not.toHaveBeenCalled();
    });
    it('deletes owned rows from the right collection', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('emails').readOne.mockResolvedValue({ id: 'x', owner: 'u1' });
        const { res } = await t.call('DELETE', '/sent/:id', { accountability: USER, params: { id: 'x' } });
        expect(res.body).toEqual({ status: 'ok', id: 'x' });
        expect(t.col('emails').deleteOne).toHaveBeenCalledWith('x');
    });
    it('500 when the delete fails', async () => {
        const t = setupEndpoint(endpoint as any);
        t.col('inbox_email').readOne.mockResolvedValue({ id: 'x', owner: 'u1' });
        t.col('inbox_email').deleteOne.mockRejectedValue(new Error('fk'));
        const { res } = await t.call('DELETE', '/inbox/:id', { accountability: USER, params: { id: 'x' } });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('fk');
    });
});
