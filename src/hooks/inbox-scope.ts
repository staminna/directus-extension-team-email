/**
 * Team Email — scope the inbox_email collection to the shared info@ mailbox
 * ------------------------------------------------------------------
 * /admin/content/inbox_email is the shared info@ mailbox and nothing
 * else. Browsing queries against inbox_email (the content page list, its
 * counts and exports, plain /items/inbox_email calls) get the shared-mailbox
 * filter ANDed in, admins included — admin access skips permissions, so a
 * policy alone could not do this.
 *
 * Queries that already target specific rows pass through untouched:
 *   - by id            (opening one item, the attachment endpoint)
 *   - by owner         (the Inbox module: owner = current user)
 *   - by thread_id     (conversation view)
 *   - by message_id /
 *     provider_message_id (inbound de-duplication)
 * Who may read which row is still decided by permissions; this hook only
 * narrows what a browse shows, it never widens anything.
 *
 * Calls without a user (system services, inbound webhook, IMAP cron) are
 * never touched.
 *
 * Set EMAIL_CONTENT_SHARED_ONLY=false to switch it off.
 */

import { defineHook } from '@directus/extensions-sdk';
import { SHARED_INBOX_FILTER } from '../api/shared-inbox';

const TARGETED_KEYS = new Set(['id', 'owner', 'thread_id', 'message_id', 'provider_message_id']);

function mentionsAny(node: unknown, keys: Set<string>): boolean {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(n => mentionsAny(n, keys));
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (keys.has(k)) return true;
        if (mentionsAny(v, keys)) return true;
    }
    return false;
}

export default defineHook(({ filter }, { env, logger }) => {
    const enabled = String(env.EMAIL_CONTENT_SHARED_ONLY ?? 'true').trim().toLowerCase() !== 'false';
    if (!enabled) {
        logger.info('email-inbox-scope: disabled (EMAIL_CONTENT_SHARED_ONLY=false)');
        return;
    }

    filter('inbox_email.items.query', (query: any, _meta: any, context: any) => {
        if (!context?.accountability?.user) return query;
        if (query?.filter && mentionsAny(query.filter, TARGETED_KEYS)) return query;

        return {
            ...query,
            filter: query?.filter ? { _and: [query.filter, SHARED_INBOX_FILTER] } : SHARED_INBOX_FILTER,
        };
    });
});
