/**
 * Team Email — IMAP routes
 * ------------------------------------------------------------------
 * Mounted under the existing /email router:
 *   GET    /email/imap/account   the caller's mailbox settings (never the password)
 *   PUT    /email/imap/account   create/update after a successful test login
 *   DELETE /email/imap/account   forget the mailbox (synced messages stay)
 *   POST   /email/imap/test      try credentials without saving
 *   POST   /email/imap/sync      pull new mail now (throttled; ?force=1 bypasses)
 *
 * Every route acts on the authenticated user only. The owner is taken from
 * req.accountability, never from the request body, and the collection has no
 * user-facing permissions at all.
 */

import { readImapConfig } from './config';
import { secretUsable, ImapSecretMissing } from './crypto';
import {
    decryptFor, deleteForOwner, findByOwner, toPublic, upsertForOwner, usernameAllowed,
    type AccountsDeps, type UpsertInput,
} from './accounts';
import { isRunning, syncAccount, verifyConnection, type SyncDeps } from './sync';

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RouteContext {
    services: any;
    getSchema: () => Promise<any>;
    env: Record<string, unknown>;
    logger: any;
    database: any;
}

function parseInput(body: any, defaults: { host: string; port: number; secure: boolean }): { ok: true; value: UpsertInput } | { ok: false; error: string } {
    const b = body && typeof body === 'object' ? body : {};
    const host = String(b.host ?? defaults.host ?? '').trim().toLowerCase();
    if (!host || host.length > 253 || !HOST_RE.test(host)) return { ok: false, error: 'host is not a valid hostname' };

    const port = Number(b.port ?? defaults.port ?? 993);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port must be between 1 and 65535' };

    const secure = b.secure == null ? defaults.secure : (b.secure === true || b.secure === 'true' || b.secure === 1 || b.secure === '1');

    const username = String(b.username ?? '').trim();
    if (!username || username.length > 320 || !EMAIL_RE.test(username)) return { ok: false, error: 'username must be the full mailbox address' };

    let password: string | undefined;
    if (b.password != null && String(b.password) !== '') {
        password = String(b.password);
        if (password.length > 512) return { ok: false, error: 'password is too long' };
    }

    const mailbox = String(b.mailbox ?? 'INBOX').trim() || 'INBOX';
    if (mailbox.length > 255 || /[\r\n\0]/.test(mailbox)) return { ok: false, error: 'mailbox name is invalid' };

    let initial_days: number | null | undefined;
    if (b.initial_days === null || b.initial_days === '') initial_days = null;
    else if (b.initial_days != null) {
        const n = Number(b.initial_days);
        if (!Number.isInteger(n) || n < 1 || n > 3650) return { ok: false, error: 'initial_days must be between 1 and 3650' };
        initial_days = n;
    }

    const is_active = b.is_active == null ? undefined : !(b.is_active === false || b.is_active === 'false' || b.is_active === 0 || b.is_active === '0');

    return { ok: true, value: { host, port, secure, username, password, mailbox, initial_days, is_active } };
}

export function registerImapRoutes(router: any, ctx: RouteContext) {
    const { services, getSchema, env, logger, database } = ctx;
    const { ItemsService, FilesService } = services;
    const cfg = readImapConfig(env);

    const deps = async (): Promise<SyncDeps> => ({
        ItemsService, FilesService, schema: await getSchema(), database, logger,
    });

    const requireUser = (req: any, res: any): string | null => {
        const user = req.accountability?.user;
        if (!user) {
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        return user;
    };

    const requireSecret = (res: any): boolean => {
        if (secretUsable(cfg.secret)) return true;
        logger.error('email-imap: EMAIL_IMAP_SECRET is missing or shorter than 16 characters');
        res.status(503).json({ error: 'service_unconfigured', message: 'IMAP is not configured on this server (EMAIL_IMAP_SECRET).' });
        return false;
    };

    const defaults = { host: cfg.defaultHost, port: cfg.defaultPort, secure: cfg.defaultSecure };

    const respondAccount = async (res: any, d: AccountsDeps, userId: string, extra: Record<string, unknown> = {}) => {
        const row = await findByOwner(d, userId);
        return res.json({
            account: row ? { ...toPublic(row), syncing: isRunning(row.id) } : null,
            defaults: { ...defaults, mailbox: 'INBOX', initial_days: cfg.initialDays, allowed_domains: cfg.allowedDomains },
            secret_configured: secretUsable(cfg.secret),
            ...extra,
        });
    };

    // -------------------------------------------------------------------
    router.get('/imap/account', async (req: any, res: any) => {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            return await respondAccount(res, await deps(), userId);
        } catch (err: any) {
            logger.error({ err }, 'email-imap: account read failed');
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });

    // -------------------------------------------------------------------
    router.post('/imap/test', async (req: any, res: any) => {
        const userId = requireUser(req, res);
        if (!userId) return;
        if (!requireSecret(res)) return;

        const parsed = parseInput(req.body, defaults);
        if (!parsed.ok) return res.status(400).json({ error: 'invalid_input', message: parsed.error });
        if (!usernameAllowed(cfg, parsed.value.username)) {
            return res.status(400).json({ error: 'invalid_input', message: `mailbox must be on: ${cfg.allowedDomains.join(', ')}` });
        }

        try {
            const d = await deps();
            let password = parsed.value.password;
            if (!password) {
                const existing = await findByOwner(d, userId);
                if (!existing) return res.status(400).json({ error: 'invalid_input', message: 'password is required' });
                password = decryptFor(cfg, existing);
            }
            const info = await verifyConnection(cfg, { ...parsed.value, password, mailbox: parsed.value.mailbox || 'INBOX' });
            return res.json({ status: 'ok', ...info });
        } catch (err: any) {
            if (err instanceof ImapSecretMissing) return res.status(503).json({ error: 'service_unconfigured', message: err.message });
            const message = err?.authenticationFailed ? 'authentication failed: check the mailbox username and password' : (err?.message ?? 'connection failed');
            return res.status(422).json({ error: 'imap_connection_failed', message });
        }
    });

    // -------------------------------------------------------------------
    router.put('/imap/account', async (req: any, res: any) => {
        const userId = requireUser(req, res);
        if (!userId) return;
        if (!requireSecret(res)) return;

        const parsed = parseInput(req.body, defaults);
        if (!parsed.ok) return res.status(400).json({ error: 'invalid_input', message: parsed.error });
        if (!usernameAllowed(cfg, parsed.value.username)) {
            return res.status(400).json({ error: 'invalid_input', message: `mailbox must be on: ${cfg.allowedDomains.join(', ')}` });
        }

        try {
            const d = await deps();
            const existing = await findByOwner(d, userId);
            if (!existing && !parsed.value.password) {
                return res.status(400).json({ error: 'invalid_input', message: 'password is required' });
            }

            // Prove the credentials work before anything is written.
            const password = parsed.value.password ?? decryptFor(cfg, existing!);
            try {
                await verifyConnection(cfg, { ...parsed.value, password, mailbox: parsed.value.mailbox || 'INBOX' });
            } catch (err: any) {
                const message = err?.authenticationFailed ? 'authentication failed: check the mailbox username and password' : (err?.message ?? 'connection failed');
                return res.status(422).json({ error: 'imap_connection_failed', message });
            }

            const row = await upsertForOwner(d, cfg, userId, parsed.value, existing);
            logger.info(`email-imap: account ${existing ? 'updated' : 'created'} for user ${userId} (${row.username}@${row.host})`);

            // First pull in the background; the screen polls GET /imap/account for status.
            if (row.is_active && !isRunning(row.id)) {
                setImmediate(() => { syncAccount(d, cfg, row).catch(() => { /* logged inside */ }); });
            }
            return await respondAccount(res, d, userId, { sync: row.is_active ? 'started' : 'inactive' });
        } catch (err: any) {
            if (err instanceof ImapSecretMissing) return res.status(503).json({ error: 'service_unconfigured', message: err.message });
            logger.error({ err }, 'email-imap: account save failed');
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });

    // -------------------------------------------------------------------
    router.delete('/imap/account', async (req: any, res: any) => {
        const userId = requireUser(req, res);
        if (!userId) return;
        try {
            const d = await deps();
            const existing = await findByOwner(d, userId);
            if (!existing) return res.status(404).json({ error: 'not_found' });
            if (isRunning(existing.id)) return res.status(409).json({ error: 'sync_running', message: 'wait for the current sync to finish' });
            await deleteForOwner(d, existing);
            logger.info(`email-imap: account removed for user ${userId}`);
            return res.json({ status: 'ok' });
        } catch (err: any) {
            logger.error({ err }, 'email-imap: account delete failed');
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });

    // -------------------------------------------------------------------
    router.post('/imap/sync', async (req: any, res: any) => {
        const userId = requireUser(req, res);
        if (!userId) return;
        if (!requireSecret(res)) return;

        const force = ['1', 'true'].includes(String(req.query?.force ?? req.body?.force ?? ''));
        const wait = !['0', 'false'].includes(String(req.query?.wait ?? req.body?.wait ?? '1'));

        try {
            const d = await deps();
            const row = await findByOwner(d, userId);
            if (!row) return res.status(404).json({ error: 'not_found', message: 'no mailbox configured' });
            if (!row.is_active) return res.json({ status: 'skipped', reason: 'inactive' });
            if (isRunning(row.id)) return res.status(202).json({ status: 'running' });

            if (!force && row.last_sync_at && row.last_sync_status === 'ok') {
                const age = (Date.now() - new Date(row.last_sync_at).getTime()) / 1000;
                if (age >= 0 && age < cfg.minIntervalSeconds) {
                    return res.json({ status: 'skipped', reason: 'recent', last_sync_at: row.last_sync_at });
                }
            }

            if (!wait) {
                setImmediate(() => { syncAccount(d, cfg, row).catch(() => { /* logged inside */ }); });
                return res.status(202).json({ status: 'started' });
            }
            const result = await syncAccount(d, cfg, row);
            return res.status(result.status === 'error' ? 502 : 200).json(result);
        } catch (err: any) {
            if (err instanceof ImapSecretMissing) return res.status(503).json({ error: 'service_unconfigured', message: err.message });
            logger.error({ err }, 'email-imap: sync route failed');
            return res.status(500).json({ error: 'internal_error', message: err?.message });
        }
    });
}
