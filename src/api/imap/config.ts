/**
 * Team Email — IMAP configuration
 * ------------------------------------------------------------------
 * Everything comes from environment variables. No credentials live in source;
 * the per-user mailbox password is the only secret and it is stored encrypted
 * (see crypto.ts).
 *
 *   EMAIL_IMAP_SECRET                 required to store/read passwords. 32+ random chars
 *   EMAIL_IMAP_DEFAULT_HOST           pre-filled host in the settings screen
 *   EMAIL_IMAP_DEFAULT_PORT           default 993
 *   EMAIL_IMAP_DEFAULT_SECURE         default true (implicit TLS)
 *   EMAIL_IMAP_ALLOWED_DOMAINS        comma list; a mailbox username must belong to one.
 *                                     Empty allows any address
 *   EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED default true. Keep it on; only relax for a
 *                                     self-signed server you control
 *   EMAIL_IMAP_SYNC_ENABLED           default true — background cron
 *   EMAIL_IMAP_SYNC_CRON              default every 2 minutes
 *   EMAIL_IMAP_MIN_INTERVAL_SECONDS   default 20 — an on-demand sync sooner than
 *                                     this after the last one is skipped
 *   EMAIL_IMAP_MAX_PER_SYNC           default 100 messages per account per run
 *   EMAIL_IMAP_INITIAL_DAYS           default 30 — how far back the first sync goes
 *   EMAIL_IMAP_MAX_MESSAGE_BYTES      default 15 MB — larger messages are stored
 *                                     envelope-only with a note in the body
 *   EMAIL_IMAP_SYNC_TIMEOUT_MS        default 120000 per account per run
 *   EMAIL_ATTACHMENTS_FOLDER          shared with the rest of the extension
 *   EMAIL_MAX_ATTACHMENT_BYTES        shared with the rest of the extension
 */

export interface ImapConfig {
    secret: string | undefined;
    defaultHost: string;
    defaultPort: number;
    defaultSecure: boolean;
    allowedDomains: string[];
    tlsRejectUnauthorized: boolean;
    syncEnabled: boolean;
    syncCron: string;
    minIntervalSeconds: number;
    maxPerSync: number;
    initialDays: number;
    maxMessageBytes: number;
    syncTimeoutMs: number;
    attachmentsFolder: string | null;
    maxAttachmentBytes: number;
    storageLocation: string;
}

function bool(v: unknown, fallback: boolean): boolean {
    if (v == null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return fallback;
}

function int(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function csv(v: unknown): string[] {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map(x => String(x).trim().toLowerCase()).filter(Boolean);
    return String(v).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function readImapConfig(env: Record<string, unknown>): ImapConfig {
    return {
        secret: env.EMAIL_IMAP_SECRET == null ? undefined : String(env.EMAIL_IMAP_SECRET),
        defaultHost: String(env.EMAIL_IMAP_DEFAULT_HOST ?? '').trim(),
        defaultPort: int(env.EMAIL_IMAP_DEFAULT_PORT, 993),
        defaultSecure: bool(env.EMAIL_IMAP_DEFAULT_SECURE, true),
        allowedDomains: csv(env.EMAIL_IMAP_ALLOWED_DOMAINS),
        tlsRejectUnauthorized: bool(env.EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED, true),
        syncEnabled: bool(env.EMAIL_IMAP_SYNC_ENABLED, true),
        syncCron: String(env.EMAIL_IMAP_SYNC_CRON ?? '*/2 * * * *').trim() || '*/2 * * * *',
        minIntervalSeconds: int(env.EMAIL_IMAP_MIN_INTERVAL_SECONDS, 20),
        maxPerSync: int(env.EMAIL_IMAP_MAX_PER_SYNC, 100),
        initialDays: int(env.EMAIL_IMAP_INITIAL_DAYS, 30),
        maxMessageBytes: int(env.EMAIL_IMAP_MAX_MESSAGE_BYTES, 15 * 1024 * 1024),
        syncTimeoutMs: int(env.EMAIL_IMAP_SYNC_TIMEOUT_MS, 120_000),
        attachmentsFolder: (env.EMAIL_ATTACHMENTS_FOLDER as string | undefined) || null,
        maxAttachmentBytes: int(env.EMAIL_MAX_ATTACHMENT_BYTES, 26_214_400),
        storageLocation: csv(env.STORAGE_LOCATIONS)[0] || 'local',
    };
}
