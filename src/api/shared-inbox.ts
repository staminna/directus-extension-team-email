/**
 * Team Email — the shared info@ mailbox, and who may reach it
 * ------------------------------------------------------------------
 * Inbound mail that matches no user's alias is stored with no owner (see
 * POST /email/inbound/postmark). Those rows ARE the shared info@ mailbox.
 * Personal mail — IMAP sync, internal sends, alias fan-out — always carries an
 * owner, so `owner IS NULL AND source = 'postmark'` separates the two cleanly.
 *
 * Who may reach the shared mailbox is configured by role, by name or id:
 *
 *   EMAIL_SHARED_INBOX_ROLES  comma-separated role names or ids
 *                             (default "Administrativo,Administrator")
 *
 * Users whose policy grants admin access always pass.
 */

export const SHARED_INBOX_FILTER = {
    _and: [{ owner: { _null: true } }, { source: { _eq: 'postmark' } }],
};

export function isSharedInboxRow(row: { owner?: unknown; source?: unknown } | null | undefined): boolean {
    if (!row) return false;
    const owner = (row.owner as any)?.id ?? row.owner;
    return (owner === null || owner === undefined) && row.source === 'postmark';
}

const DEFAULT_ROLES = 'Administrativo,Administrator';
const ROLE_CACHE_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function csv(value: unknown): string[] {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

export function createSharedInboxAccess(opts: { database: any; env: Record<string, unknown>; logger: any }) {
    const wanted = csv(opts.env.EMAIL_SHARED_INBOX_ROLES ?? DEFAULT_ROLES);
    const wantedIds = wanted.filter(v => UUID_RE.test(v));
    const wantedNames = wanted.filter(v => !UUID_RE.test(v));
    let cache: { at: number; ids: Set<string> } | null = null;

    async function allowedRoleIds(): Promise<Set<string>> {
        if (cache && Date.now() - cache.at < ROLE_CACHE_MS) return cache.ids;
        try {
            const rows: Array<{ id: string }> = await opts.database('directus_roles')
                .select('id')
                .where((q: any) => {
                    q.whereIn('id', wantedIds.length ? wantedIds : ['00000000-0000-0000-0000-000000000000']);
                    if (wantedNames.length) q.orWhereIn('name', wantedNames);
                });
            cache = { at: Date.now(), ids: new Set(rows.map(r => String(r.id))) };
        } catch (err) {
            // Fail closed: nobody but admins gets in while the lookup is broken.
            opts.logger.error({ err }, 'email-shared-inbox: could not resolve allowed roles');
            cache = { at: Date.now(), ids: new Set() };
        }
        return cache.ids;
    }

    return {
        async canAccess(accountability: any): Promise<boolean> {
            if (!accountability?.user) return false;
            if (accountability.admin === true) return true;
            const ids = await allowedRoleIds();
            // `roles` holds the role and its parents (nested roles, Directus 11+).
            const mine = [accountability.role, ...(accountability.roles ?? [])].filter(Boolean).map(String);
            return mine.some(r => ids.has(r));
        },
    };
}
