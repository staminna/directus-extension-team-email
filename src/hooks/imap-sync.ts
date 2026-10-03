/**
 * Team Email — IMAP background sync
 * ------------------------------------------------------------------
 * Every EMAIL_IMAP_SYNC_CRON (default: every 2 minutes) pull new mail for
 * every active account, one account at a time. Per-account locking lives in
 * sync.ts, so an on-demand sync from the UI and this cron never overlap on the
 * same mailbox, and a slow run never stacks up behind itself.
 *
 * Set EMAIL_IMAP_SYNC_ENABLED=false to rely on the on-demand sync only (the
 * inbox screen triggers one when it opens).
 */

import { defineHook } from '@directus/extensions-sdk';
import { readImapConfig } from '../api/imap/config';
import { secretUsable } from '../api/imap/crypto';
import { listActive } from '../api/imap/accounts';
import { isRunning, syncAccount } from '../api/imap/sync';

export default defineHook(({ schedule, init }, { services, getSchema, env, logger, database }) => {
    const cfg = readImapConfig(env as Record<string, unknown>);
    const { ItemsService, FilesService } = services as any;

    let tickRunning = false;

    init('app.after', () => {
        if (!secretUsable(cfg.secret)) {
            logger.warn('email-imap: EMAIL_IMAP_SECRET not set — mailbox sync is disabled until it is');
        } else if (!cfg.syncEnabled) {
            logger.info('email-imap: background sync disabled (EMAIL_IMAP_SYNC_ENABLED=false)');
        } else {
            logger.info(`email-imap: background sync scheduled (${cfg.syncCron})`);
        }
    });

    if (!cfg.syncEnabled) return;

    schedule(cfg.syncCron, async () => {
        if (!secretUsable(cfg.secret)) return;
        if (tickRunning) {
            logger.debug('email-imap: previous tick still running; skipping');
            return;
        }
        tickRunning = true;
        try {
            const deps = { ItemsService, FilesService, schema: await getSchema(), database, logger };
            const accounts = await listActive(deps);
            for (const row of accounts) {
                if (isRunning(row.id)) continue;
                try {
                    await syncAccount(deps, cfg, row);
                } catch (err) {
                    logger.error({ err, account: row.id }, 'email-imap: cron sync threw');
                }
            }
        } catch (err) {
            logger.error({ err }, 'email-imap: cron tick failed');
        } finally {
            tickRunning = false;
        }
    });
});
