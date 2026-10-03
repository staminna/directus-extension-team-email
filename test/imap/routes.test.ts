import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncMock = vi.hoisted(() => ({
    running: new Set<string>(),
    verifyConnection: vi.fn(),
    syncAccount: vi.fn(),
}));
vi.mock('../../src/api/imap/sync', () => ({
    isRunning: (id: string) => syncMock.running.has(id),
    verifyConnection: syncMock.verifyConnection,
    syncAccount: syncMock.syncAccount,
}));

import { encryptPassword } from '../../src/api/imap/crypto';
import { registerImapRoutes } from '../../src/api/imap/routes';
import { logger, makeItemsService } from './helpers';

const SECRET = 'r'.repeat(32);

function makeRouter() {
    const routes = new Map<string, (req: any, res: any) => any>();
    const add = (m: string) => (path: string, h: any) => routes.set(`${m} ${path}`, h);
    return {
        routes,
        get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    };
}

function res() {
    const r: any = { statusCode: 200, body: undefined };
    r.status = vi.fn((c: number) => { r.statusCode = c; return r; });
    r.json = vi.fn((b: any) => { r.body = b; return r; });
    return r;
}

function setup(env: Record<string, unknown> = { EMAIL_IMAP_SECRET: SECRET }) {
    const items = makeItemsService();
    const log = logger();
    const router = makeRouter();
    registerImapRoutes(router, {
        services: { ItemsService: items.ItemsService, FilesService: class {} },
        getSchema: async () => ({}),
        env,
        logger: log,
        database: {},
    });
    const call = async (method: string, path: string, req: any = {}) => {
        const r = res();
        await router.routes.get(`${method} ${path}`)!({ accountability: { user: 'u1' }, query: {}, body: {}, ...req }, r);
        return r;
    };
    const seed = (over: any = {}) => {
        const row = {
            id: 'acc', owner: 'u1', host: 'imap.test.com', port: 993, secure: true, username: 'me@test.com',
            password_enc: encryptPassword(SECRET, 'stored-pw', 'u1'), mailbox: 'INBOX', is_active: true,
            initial_days: null, uid_validity: null, last_uid: 0, last_sync_at: null, last_sync_status: 'never', last_error: null, ...over,
        };
        items.store.email_imap_accounts = new Map([['acc', row]]);
        return row;
    };
    return { items, log, call, seed };
}

const valid = { host: 'IMAP.Test.com', port: 993, secure: true, username: 'me@test.com', password: 'pw' };

beforeEach(() => {
    syncMock.running.clear();
    syncMock.verifyConnection.mockReset().mockResolvedValue({ exists: 1, uid_next: 2 });
    syncMock.syncAccount.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('imap routes: auth & config', () => {
    it('requires a user on every route', async () => {
        const s = setup();
        for (const [m, p] of [['GET', '/imap/account'], ['POST', '/imap/test'], ['PUT', '/imap/account'], ['DELETE', '/imap/account'], ['POST', '/imap/sync']]) {
            const r = await s.call(m, p, { accountability: null });
            expect(r.statusCode).toBe(401);
        }
    });

    it('returns 503 when the secret is missing', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: 'short' });
        for (const [m, p] of [['POST', '/imap/test'], ['PUT', '/imap/account'], ['POST', '/imap/sync']]) {
            const r = await s.call(m, p, { body: valid });
            expect(r.statusCode).toBe(503);
            expect(r.body.error).toBe('service_unconfigured');
        }
        expect(s.log.error).toHaveBeenCalled();
    });
});

describe('GET /imap/account', () => {
    it('returns null account with defaults', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET, EMAIL_IMAP_DEFAULT_HOST: 'mail.x', EMAIL_IMAP_ALLOWED_DOMAINS: 'test.com' });
        const r = await s.call('GET', '/imap/account');
        expect(r.body).toEqual({
            account: null,
            defaults: { host: 'mail.x', port: 993, secure: true, mailbox: 'INBOX', initial_days: 30, allowed_domains: ['test.com'] },
            secret_configured: true,
        });
    });

    it('returns the public account with syncing state', async () => {
        const s = setup();
        s.seed();
        syncMock.running.add('acc');
        const r = await s.call('GET', '/imap/account');
        expect(r.body.account).toMatchObject({ id: 'acc', has_password: true, syncing: true });
        expect(r.body.account).not.toHaveProperty('password_enc');
    });

    it('500s on storage errors', async () => {
        const s = setup();
        s.items.ItemsService.prototype.readByQuery = async () => { throw new Error('db'); };
        const r = await s.call('GET', '/imap/account');
        expect(r.statusCode).toBe(500);
        expect(r.body).toEqual({ error: 'internal_error', message: 'db' });
    });
});

describe('input validation (via POST /imap/test)', () => {
    const cases: Array<[any, RegExp]> = [
        [{ ...valid, host: 'bad host!' }, /host/],
        [{ ...valid, host: '' }, /host/],
        [{ ...valid, host: 'a'.repeat(254) }, /host/],
        [{ ...valid, port: 0 }, /port/],
        [{ ...valid, port: 70000 }, /port/],
        [{ ...valid, port: 1.5 }, /port/],
        [{ ...valid, username: 'nope' }, /username/],
        [{ ...valid, username: '' }, /username/],
        [{ ...valid, password: 'x'.repeat(513) }, /too long/],
        [{ ...valid, mailbox: 'a\nb' }, /mailbox/],
        [{ ...valid, mailbox: 'm'.repeat(256) }, /mailbox/],
        [{ ...valid, initial_days: 0 }, /initial_days/],
        [{ ...valid, initial_days: 'abc' }, /initial_days/],
        [null, /host/],
    ];
    it.each(cases)('rejects %j', async (body, msg) => {
        const s = setup();
        const r = await s.call('POST', '/imap/test', { body });
        expect(r.statusCode).toBe(400);
        expect(r.body.message).toMatch(msg);
    });

    it('enforces allowed domains', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET, EMAIL_IMAP_ALLOWED_DOMAINS: 'corp.com,corp.pt' });
        for (const [m, p] of [['POST', '/imap/test'], ['PUT', '/imap/account']]) {
            const r = await s.call(m, p, { body: valid });
            expect(r.statusCode).toBe(400);
            expect(r.body.message).toBe('mailbox must be on: corp.com, corp.pt');
        }
    });
});

describe('POST /imap/test', () => {
    it('verifies with the given password and normalised input', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET, EMAIL_IMAP_DEFAULT_HOST: 'default.host' });
        const r = await s.call('POST', '/imap/test', { body: { username: 'me@test.com', password: 'pw', secure: 'false', mailbox: '  ', initial_days: '' } });
        expect(r.body).toEqual({ status: 'ok', exists: 1, uid_next: 2 });
        expect(syncMock.verifyConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            host: 'default.host', port: 993, secure: false, password: 'pw', mailbox: 'INBOX',
        }));
    });

    it('uses the stored password when none is given, or 400s', async () => {
        const s = setup();
        let r = await s.call('POST', '/imap/test', { body: { ...valid, password: '' } });
        expect(r.statusCode).toBe(400);
        expect(r.body.message).toBe('password is required');
        s.seed();
        r = await s.call('POST', '/imap/test', { body: { ...valid, password: undefined, secure: 1 } });
        expect(r.body.status).toBe('ok');
        expect(syncMock.verifyConnection.mock.calls[0][1].password).toBe('stored-pw');
    });

    it('maps connection failures', async () => {
        const s = setup();
        syncMock.verifyConnection.mockRejectedValueOnce({ authenticationFailed: true });
        let r = await s.call('POST', '/imap/test', { body: valid });
        expect(r.statusCode).toBe(422);
        expect(r.body.message).toMatch(/authentication failed/);
        syncMock.verifyConnection.mockRejectedValueOnce(new Error('ECONN'));
        r = await s.call('POST', '/imap/test', { body: valid });
        expect(r.body.message).toBe('ECONN');
        syncMock.verifyConnection.mockRejectedValueOnce(undefined);
        r = await s.call('POST', '/imap/test', { body: valid });
        expect(r.body.message).toBe('connection failed');
    });

    it('503s when the stored password cannot be decrypted with the current secret', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET });
        s.seed();
        const { ImapSecretMissing } = await import('../../src/api/imap/crypto');
        syncMock.verifyConnection.mockRejectedValueOnce(new ImapSecretMissing());
        const r = await s.call('POST', '/imap/test', { body: valid });
        expect(r.statusCode).toBe(503);
    });
});

describe('PUT /imap/account', () => {
    it('requires a password for a new account', async () => {
        const s = setup();
        const r = await s.call('PUT', '/imap/account', { body: { ...valid, password: '' } });
        expect(r.statusCode).toBe(400);
    });

    it('creates the account and starts a background sync', async () => {
        const s = setup();
        const r = await s.call('PUT', '/imap/account', { body: { ...valid, initial_days: 10, is_active: 'true' } });
        expect(r.statusCode).toBe(200);
        expect(r.body.sync).toBe('started');
        expect(r.body.account).toMatchObject({ host: 'imap.test.com', initial_days: 10, is_active: true });
        await new Promise(res => setImmediate(res));
        expect(syncMock.syncAccount).toHaveBeenCalledTimes(1);
        expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining('account created'));
    });

    it('updates an existing account using the stored password; inactive skips sync', async () => {
        const s = setup();
        s.seed();
        syncMock.syncAccount.mockRejectedValue(new Error('ignored'));
        const r = await s.call('PUT', '/imap/account', { body: { ...valid, password: undefined, is_active: false } });
        expect(r.body.sync).toBe('inactive');
        expect(syncMock.verifyConnection.mock.calls[0][1].password).toBe('stored-pw');
        expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining('account updated'));
        await new Promise(res => setImmediate(res));
        expect(syncMock.syncAccount).not.toHaveBeenCalled();
    });

    it('does not start a second sync while one runs, and swallows background errors', async () => {
        const s = setup();
        s.seed();
        syncMock.running.add('acc');
        let r = await s.call('PUT', '/imap/account', { body: valid });
        expect(r.body.sync).toBe('started');
        await new Promise(res => setImmediate(res));
        expect(syncMock.syncAccount).not.toHaveBeenCalled();
        syncMock.running.clear();
        syncMock.syncAccount.mockRejectedValue(new Error('bg'));
        r = await s.call('PUT', '/imap/account', { body: valid });
        await new Promise(res => setImmediate(res));
        expect(syncMock.syncAccount).toHaveBeenCalled();
    });

    it('maps verify failures to 422 without writing', async () => {
        const s = setup();
        syncMock.verifyConnection.mockRejectedValueOnce({ authenticationFailed: true });
        let r = await s.call('PUT', '/imap/account', { body: valid });
        expect(r.statusCode).toBe(422);
        expect(r.body.message).toMatch(/authentication failed/);
        syncMock.verifyConnection.mockRejectedValueOnce(new Error('timeout'));
        r = await s.call('PUT', '/imap/account', { body: valid });
        expect(r.body.message).toBe('timeout');
        syncMock.verifyConnection.mockRejectedValueOnce(null);
        r = await s.call('PUT', '/imap/account', { body: valid });
        expect(r.body.message).toBe('connection failed');
        expect(s.items.store.email_imap_accounts?.size ?? 0).toBe(0);
    });

    it('503 on secret errors and 500 on storage errors', async () => {
        const s = setup();
        s.seed({ password_enc: 'bad' });
        let r = await s.call('PUT', '/imap/account', { body: { ...valid, password: undefined } });
        expect(r.statusCode).toBe(500);
        expect(s.log.error).toHaveBeenCalled();

        const { ImapSecretMissing } = await import('../../src/api/imap/crypto');
        s.items.ItemsService.prototype.readByQuery = async () => { throw new ImapSecretMissing(); };
        r = await s.call('PUT', '/imap/account', { body: valid });
        expect(r.statusCode).toBe(503);
    });
});

describe('DELETE /imap/account', () => {
    it('404, 409, ok, 500', async () => {
        const s = setup();
        expect((await s.call('DELETE', '/imap/account')).statusCode).toBe(404);
        s.seed();
        syncMock.running.add('acc');
        expect((await s.call('DELETE', '/imap/account')).statusCode).toBe(409);
        syncMock.running.clear();
        const ok = await s.call('DELETE', '/imap/account');
        expect(ok.body).toEqual({ status: 'ok' });
        expect(s.items.store.email_imap_accounts!.size).toBe(0);
        s.items.ItemsService.prototype.readByQuery = async () => { throw new Error('db'); };
        expect((await s.call('DELETE', '/imap/account')).statusCode).toBe(500);
    });
});

describe('POST /imap/sync', () => {
    it('404 without account, skipped when inactive, 202 when running', async () => {
        const s = setup();
        expect((await s.call('POST', '/imap/sync')).statusCode).toBe(404);
        s.seed({ is_active: false });
        expect((await s.call('POST', '/imap/sync')).body).toEqual({ status: 'skipped', reason: 'inactive' });
        s.seed();
        syncMock.running.add('acc');
        const r = await s.call('POST', '/imap/sync');
        expect(r.statusCode).toBe(202);
        expect(r.body).toEqual({ status: 'running' });
    });

    it('throttles recent successful syncs unless forced', async () => {
        const s = setup();
        const at = new Date(Date.now() - 5_000).toISOString();
        s.seed({ last_sync_at: at, last_sync_status: 'ok' });
        let r = await s.call('POST', '/imap/sync');
        expect(r.body).toEqual({ status: 'skipped', reason: 'recent', last_sync_at: at });
        r = await s.call('POST', '/imap/sync', { query: { force: '1' } });
        expect(r.body).toEqual({ status: 'ok' });
        r = await s.call('POST', '/imap/sync', { query: undefined, body: { force: 'true' } });
        expect(r.body).toEqual({ status: 'ok' });
    });

    it('runs after the interval and with future timestamps', async () => {
        const s = setup();
        s.seed({ last_sync_at: new Date(Date.now() - 60_000).toISOString(), last_sync_status: 'ok' });
        expect((await s.call('POST', '/imap/sync')).statusCode).toBe(200);
        s.seed({ last_sync_at: new Date(Date.now() + 60_000).toISOString(), last_sync_status: 'ok' });
        expect((await s.call('POST', '/imap/sync')).statusCode).toBe(200);
    });

    it('502 when sync errors; wait=0 runs in background', async () => {
        const s = setup();
        s.seed();
        syncMock.syncAccount.mockResolvedValueOnce({ status: 'error', error: 'x' });
        expect((await s.call('POST', '/imap/sync')).statusCode).toBe(502);
        syncMock.syncAccount.mockRejectedValueOnce(new Error('bg'));
        const r = await s.call('POST', '/imap/sync', { query: { wait: '0' } });
        expect(r.statusCode).toBe(202);
        expect(r.body).toEqual({ status: 'started' });
        await new Promise(res => setImmediate(res));
        expect(syncMock.syncAccount).toHaveBeenCalledTimes(2);
    });

    it('503 on ImapSecretMissing and 500 otherwise', async () => {
        const s = setup();
        s.seed();
        const { ImapSecretMissing } = await import('../../src/api/imap/crypto');
        syncMock.syncAccount.mockRejectedValueOnce(new ImapSecretMissing());
        expect((await s.call('POST', '/imap/sync')).statusCode).toBe(503);
        syncMock.syncAccount.mockRejectedValueOnce(new Error('boom'));
        const r = await s.call('POST', '/imap/sync');
        expect(r.statusCode).toBe(500);
        expect(r.body.message).toBe('boom');
    });
});
