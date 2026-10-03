/**
 * Team Email — IMAP → inbox_email sync
 * ------------------------------------------------------------------
 * Pulls new messages from one user's IMAP mailbox into their Directus inbox.
 * Rows are written in exactly the shape the inbound (Postmark-format) route
 * writes them, so Inbox, Thread and attachments work unchanged; the only
 * difference is `source = 'imap'`.
 *
 * Cursor: (uid_validity, last_uid) per account. UIDs are stable within one
 * mailbox as long as UIDVALIDITY does not change; when it does, the cursor is
 * reset and the mailbox is backfilled again from EMAIL_IMAP_INITIAL_DAYS. The
 * per-owner unique index on (source, provider_message_id, owner) guarantees
 * that a re-run never duplicates a message.
 *
 * Read-only: the mailbox is opened read-only and no flags are ever written, so
 * nothing here can alter the user's real mailbox.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import type { ImapConfig } from './config';
import { decryptFor, patchSyncState, type AccountsDeps, type ImapAccountRow } from './accounts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export interface SyncDeps extends AccountsDeps {
    FilesService: any;
    logger: any;
}

export interface SyncResult {
    status: 'ok' | 'error' | 'running' | 'skipped';
    reason?: string;
    fetched: number;
    stored: number;
    skipped: number;
    last_uid: number;
    /** More messages remained after EMAIL_IMAP_MAX_PER_SYNC; the next run continues. */
    truncated: boolean;
    error?: string;
}

export interface ConnectionParams {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    mailbox: string;
}

// -----------------------------------------------------------------------------
// Helpers (kept local so the hook entry does not import the endpoint entry)
// -----------------------------------------------------------------------------
function normalizeMessageId(id: string | undefined | null): string | null {
    if (!id) return null;
    const trimmed = String(id).trim();
    if (!trimmed) return null;
    return `<${trimmed.replace(/^<+|>+$/g, '')}>`;
}

function parseReferences(refs: string | undefined | null): string[] {
    if (!refs) return [];
    return String(refs).split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => normalizeMessageId(s)!);
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function htmlToText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function errMessage(err: unknown): string {
    if (!err) return 'unknown error';
    const e = err as any;
    if (e.authenticationFailed) return 'authentication failed: check the mailbox username and password';
    const code = e.code ? ` [${e.code}]` : '';
    return `${e.message ?? String(err)}${code}`;
}

/** Reject if `promise` doesn't settle within `ms`; runs `onTimeout` first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                try { onTimeout?.(); } catch { /* ignore */ }
                reject(new Error(`${label} timed out after ${ms}ms`));
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

// -----------------------------------------------------------------------------
// IMAP client
// -----------------------------------------------------------------------------
function makeClient(cfg: ImapConfig, p: ConnectionParams): ImapFlow {
    return new ImapFlow({
        host: p.host,
        port: p.port,
        secure: p.secure,
        // STARTTLS on a plain port when the server offers it; never silently plain.
        doSTARTTLS: p.secure ? undefined : true,
        servername: p.host,
        auth: { user: p.username, pass: p.password },
        tls: { rejectUnauthorized: cfg.tlsRejectUnauthorized, minVersion: 'TLSv1.2' },
        logger: false,
        emitLogs: false,
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 90_000,
        disableAutoIdle: true,
        clientInfo: { name: 'directus-team-email', vendor: 'staminna' },
    } as any);
}

async function closeQuietly(client: ImapFlow | null) {
    if (!client) return;
    try {
        await withTimeout(client.logout(), 5_000, 'imap logout');
    } catch {
        try { client.close(); } catch { /* ignore */ }
    }
}

/**
 * Open a connection, select the mailbox read-only, report what is there and
 * disconnect. Used by "test connection" and before saving credentials.
 */
export async function verifyConnection(cfg: ImapConfig, p: ConnectionParams): Promise<{ exists: number; uid_next: number | null }> {
    const client = makeClient(cfg, p);
    try {
        await withTimeout(client.connect(), 30_000, 'imap connect', () => client.close());
        const lock = await client.getMailboxLock(p.mailbox || 'INBOX', { readOnly: true });
        try {
            const mb: any = client.mailbox;
            return { exists: Number(mb?.exists ?? 0), uid_next: mb?.uidNext == null ? null : Number(mb.uidNext) };
        } finally {
            lock.release();
        }
    } finally {
        await closeQuietly(client);
    }
}

// -----------------------------------------------------------------------------
// Sync
// -----------------------------------------------------------------------------
const running = new Set<string>();

export function isRunning(accountId: string): boolean {
    return running.has(accountId);
}

export async function syncAccount(deps: SyncDeps, cfg: ImapConfig, row: ImapAccountRow): Promise<SyncResult> {
    const result: SyncResult = {
        status: 'ok', fetched: 0, stored: 0, skipped: 0,
        last_uid: Number(row.last_uid ?? 0), truncated: false,
    };

    if (running.has(row.id)) {
        return { ...result, status: 'running', reason: 'a sync for this account is already in progress' };
    }
    running.add(row.id);

    const { logger } = deps;
    const tag = `email-imap[${row.username}]`;
    let client: ImapFlow | null = null;

    try {
        await patchSyncState(deps, row.id, { last_sync_status: 'running', last_error: null });

        const password = decryptFor(cfg, row);
        client = makeClient(cfg, {
            host: row.host, port: Number(row.port), secure: !!row.secure,
            username: row.username, password, mailbox: row.mailbox || 'INBOX',
        });

        const work = (async () => {
            await client!.connect();
            const lock = await client!.getMailboxLock(row.mailbox || 'INBOX', { readOnly: true });
            try {
                const mb: any = client!.mailbox;
                const validity: bigint = mb.uidValidity;
                const uidNext: number | null = mb.uidNext == null ? null : Number(mb.uidNext);

                let lastUid = Number(row.last_uid ?? 0);
                const storedValidity = row.uid_validity == null ? null : BigInt(row.uid_validity);
                if (storedValidity != null && validity != null && storedValidity !== validity) {
                    logger.warn(`${tag}: UIDVALIDITY changed ${storedValidity} -> ${validity}; resetting cursor`);
                    lastUid = 0;
                }

                // ----- Which UIDs are new -----
                let uids: number[] = [];
                if (lastUid === 0) {
                    const days = Number(row.initial_days ?? cfg.initialDays) || cfg.initialDays;
                    const since = new Date(Date.now() - days * 86_400_000);
                    const found = await client!.search({ since }, { uid: true });
                    uids = Array.isArray(found) ? found : [];
                } else if (uidNext != null && lastUid + 1 >= uidNext) {
                    uids = []; // nothing arrived; also avoids the "n:*" quirk when n > max UID
                } else {
                    const found = await client!.search({ uid: `${lastUid + 1}:*` }, { uid: true });
                    uids = Array.isArray(found) ? found : [];
                }
                uids = uids.map(Number).filter(u => Number.isFinite(u) && u > lastUid).sort((a, b) => a - b);

                if (uids.length > cfg.maxPerSync) {
                    result.truncated = true;
                    uids = uids.slice(0, cfg.maxPerSync);
                }
                result.fetched = uids.length;

                // ----- Fetch in small batches: metadata first, then bodies of the ones that fit -----
                for (const batch of chunk(uids, 20)) {
                    const metas: any[] = await client!.fetchAll(
                        batch,
                        { uid: true, size: true, flags: true, internalDate: true, envelope: true },
                        { uid: true },
                    );
                    metas.sort((a, b) => a.uid - b.uid);

                    const fetchable = metas.filter(m => Number(m.size ?? 0) <= cfg.maxMessageBytes).map(m => m.uid);
                    const sources = fetchable.length
                        ? await client!.fetchAll(fetchable, { uid: true, source: true }, { uid: true })
                        : [];
                    const sourceByUid = new Map<number, Buffer>();
                    for (const s of sources as any[]) if (s.source) sourceByUid.set(s.uid, s.source as Buffer);

                    for (const m of metas) {
                        try {
                            const stored = await storeMessage(deps, cfg, row, validity, m, sourceByUid.get(m.uid) ?? null);
                            if (stored) result.stored++; else result.skipped++;
                        } catch (err) {
                            // One bad message must not stall the cursor forever: log, count, move on.
                            logger.error({ err, uid: m.uid }, `${tag}: failed to store message`);
                            result.skipped++;
                        }
                        lastUid = Math.max(lastUid, Number(m.uid));
                    }

                    // Checkpoint after every batch so a crash re-processes at most one batch,
                    // and the unique index makes that re-processing a no-op.
                    result.last_uid = lastUid;
                    await patchSyncState(deps, row.id, { uid_validity: String(validity), last_uid: lastUid });
                }

                // First run on an empty window still needs the validity recorded.
                result.last_uid = lastUid;
                await patchSyncState(deps, row.id, { uid_validity: String(validity), last_uid: lastUid });
            } finally {
                lock.release();
            }
        })();

        await withTimeout(work, cfg.syncTimeoutMs, `${tag} sync`, () => { try { client?.close(); } catch { /* ignore */ } });

        await patchSyncState(deps, row.id, {
            last_sync_at: new Date().toISOString(),
            last_sync_status: 'ok',
            last_error: null,
        });
        if (result.stored > 0 || result.fetched > 0) {
            logger.info(`${tag}: fetched=${result.fetched} stored=${result.stored} skipped=${result.skipped} last_uid=${result.last_uid}${result.truncated ? ' (more pending)' : ''}`);
        }
        return result;
    } catch (err) {
        const message = errMessage(err);
        logger.warn(`${tag}: sync failed: ${message}`);
        try {
            await patchSyncState(deps, row.id, {
                last_sync_at: new Date().toISOString(),
                last_sync_status: 'error',
                last_error: message.slice(0, 1000),
            });
        } catch { /* bookkeeping only */ }
        return { ...result, status: 'error', error: message };
    } finally {
        await closeQuietly(client);
        running.delete(row.id);
    }
}

// -----------------------------------------------------------------------------
// One message → one inbox_email row for the account owner
// -----------------------------------------------------------------------------
async function storeMessage(
    deps: SyncDeps,
    cfg: ImapConfig,
    row: ImapAccountRow,
    validity: bigint,
    meta: any,
    source: Buffer | null,
): Promise<boolean> {
    const { ItemsService, FilesService, schema, database, logger } = deps;
    const inboxSvc = new ItemsService('inbox_email', { schema, knex: database });
    const sentSvc = new ItemsService('emails', { schema, knex: database });

    const providerMessageId = `imap:${validity}:${meta.uid}`;

    // ----- Idempotency 1: this exact IMAP message, this owner -----
    const dup = await inboxSvc.readByQuery({
        filter: { source: { _eq: 'imap' }, provider_message_id: { _eq: providerMessageId }, owner: { _eq: row.owner } },
        fields: ['id'],
        limit: 1,
    });
    if (dup[0]) return false;

    // ----- Parse -----
    const envelope = meta.envelope ?? {};
    let parsed: any = null;
    if (source) {
        try {
            parsed = await PostalMime.parse(source);
        } catch (err) {
            logger.warn({ err, uid: meta.uid }, 'email-imap: could not parse message source; storing envelope only');
        }
    }

    const messageId = normalizeMessageId(parsed?.messageId ?? envelope.messageId);
    const inReplyTo = normalizeMessageId(parsed?.inReplyTo ?? envelope.inReplyTo);
    const refs = parseReferences(parsed?.references);

    // ----- Idempotency 2: same Message-ID already in this owner's inbox -----
    // Covers a message sent from Directus and mirrored into this user's inbox by
    // the send fan-out, and mail that also arrived through the inbound webhook.
    if (messageId) {
        const mirrored = await inboxSvc.readByQuery({
            filter: { message_id: { _eq: messageId }, owner: { _eq: row.owner } },
            fields: ['id'],
            limit: 1,
        });
        if (mirrored[0]) return false;
    }

    // ----- Threading (same rules as the inbound route) -----
    let threadId: string | null = null;
    const candidates = [inReplyTo, ...refs].filter(Boolean) as string[];
    if (candidates.length > 0) {
        const inboxParents = await inboxSvc.readByQuery({ filter: { message_id: { _in: candidates } }, fields: ['thread_id'], limit: 1 });
        if (inboxParents[0]?.thread_id) {
            threadId = inboxParents[0].thread_id;
        } else {
            const sentParents = await sentSvc.readByQuery({ filter: { message_id: { _in: candidates } }, fields: ['thread_id'], limit: 1 });
            if (sentParents[0]?.thread_id) threadId = sentParents[0].thread_id;
        }
    }
    if (!threadId) threadId = randomUUID();

    // ----- Addresses -----
    const addr = (a: any) => ({ email: String(a?.address ?? '').trim(), name: a?.name ? String(a.name) : undefined });
    const fromParsed = parsed?.from ?? (Array.isArray(envelope.from) ? envelope.from[0] : null);
    const fromAddress = String(fromParsed?.address ?? '').trim() || null;
    const fromName = fromParsed?.name ? String(fromParsed.name) : null;
    const toList = (parsed?.to ?? envelope.to ?? []).map(addr).filter((a: any) => a.email);
    const ccList = (parsed?.cc ?? envelope.cc ?? []).map(addr).filter((a: any) => a.email);
    const replyToList = (parsed?.replyTo ?? envelope.replyTo ?? []).map(addr).filter((a: any) => a.email);

    // ----- Bodies -----
    let bodyHtml: string | null = parsed?.html ? String(parsed.html) : null;
    let bodyText: string | null = parsed?.text ? String(parsed.text) : null;
    if (!bodyText && bodyHtml) bodyText = htmlToText(bodyHtml) || null;
    if (!source) {
        const mb = (Number(meta.size ?? 0) / (1024 * 1024)).toFixed(1);
        bodyText = `(message not imported: ${mb} MB exceeds the ${(cfg.maxMessageBytes / (1024 * 1024)).toFixed(0)} MB limit — open it in your mail client)`;
        bodyHtml = null;
    }

    // ----- Attachments → directus_files -----
    const attachmentIds: string[] = [];
    if (parsed?.attachments?.length) {
        const filesSvc = new FilesService({ schema, knex: database });
        let total = 0;
        for (const att of parsed.attachments as any[]) {
            try {
                const buffer: Buffer = Buffer.isBuffer(att.content)
                    ? att.content
                    : typeof att.content === 'string'
                        ? Buffer.from(att.content, att.encoding === 'base64' ? 'base64' : 'utf8')
                        : Buffer.from(new Uint8Array(att.content));
                total += buffer.length;
                if (total > cfg.maxAttachmentBytes) {
                    logger.warn(`email-imap: attachment cap reached on uid ${meta.uid}; skipping remaining attachments`);
                    break;
                }
                const filename = att.filename || (att.contentId ? `inline-${String(att.contentId).replace(/[<>]/g, '')}` : `attachment-${attachmentIds.length + 1}`);
                const fileId = await filesSvc.uploadOne(Readable.from(buffer), {
                    filename_download: filename,
                    type: att.mimeType || 'application/octet-stream',
                    storage: cfg.storageLocation,
                    title: filename,
                    filesize: buffer.length,
                    ...(cfg.attachmentsFolder ? { folder: cfg.attachmentsFolder } : {}),
                });
                attachmentIds.push(fileId);
            } catch (err) {
                logger.error({ err, filename: att?.filename, uid: meta.uid }, 'email-imap: attachment upload failed');
            }
        }
    }

    // ----- Received time / read state -----
    const internal = meta.internalDate ? new Date(meta.internalDate) : null;
    const headerDate = parsed?.date ? new Date(parsed.date) : (envelope.date ? new Date(envelope.date) : null);
    const receivedAt = (internal && !isNaN(internal.getTime())) ? internal
        : (headerDate && !isNaN(headerDate.getTime())) ? headerDate
        : new Date();
    const flags: Set<string> = meta.flags instanceof Set ? meta.flags : new Set(Array.isArray(meta.flags) ? meta.flags : []);
    const isRead = flags.has('\\Seen');

    await inboxSvc.createOne({
        source: 'imap',
        from_address: fromAddress,
        from_name: fromName,
        to_addresses: toList,
        cc_addresses: ccList,
        reply_to: replyToList[0]?.email ?? null,
        subject: (parsed?.subject ?? envelope.subject ?? '') || '(no subject)',
        body_html: bodyHtml,
        body_text: bodyText,
        message_id: messageId,
        in_reply_to: inReplyTo,
        references_header: refs.length ? refs.join(' ') : null,
        thread_id: threadId,
        provider_message_id: providerMessageId,
        is_internal: false,
        is_read: isRead,
        read_at: isRead ? receivedAt.toISOString() : null,
        received_at: receivedAt.toISOString(),
        owner: row.owner,
        tenant: null,
        raw_payload: {
            imap: {
                account: row.id,
                mailbox: row.mailbox || 'INBOX',
                uid: meta.uid,
                uid_validity: String(validity),
                size: meta.size ?? null,
                flags: [...flags],
            },
            headers: Array.isArray(parsed?.headers)
                ? parsed.headers.map((h: any) => ({ key: h.key, value: h.value }))
                : null,
        },
        attachments: attachmentIds.map(fid => ({ directus_files_id: fid })),
    });
    return true;
}
