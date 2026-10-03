/**
 * Team Email — API
 * ------------------------------------------------------------------
 * Routes mounted under /email :
 *   GET    /email/health              liveness probe (public)
 *   GET    /email/recipients          addressable users (authenticated)
 *   GET    /email/message/:id/body    one message body as its own document
 *   POST   /email/inbound/postmark    inbound webhook, Postmark payload format
 *   POST   /email/send                send to any address, record in `emails`
 *   POST   /email/internal/send       send to other Directus users only
 *   GET    /email/threads/:id         one conversation, inbox + sent merged
 *   POST   /email/inbox/:id/read      mark read / unread
 *   DELETE /email/inbox/:id           delete a received message you own
 *   DELETE /email/sent/:id            delete a sent message you own
 *   GET    /email/imap/account        the caller's IMAP mailbox settings (no password)
 *   PUT    /email/imap/account        connect / update the mailbox (tested before saving)
 *   DELETE /email/imap/account        forget the mailbox
 *   POST   /email/imap/test           test credentials without saving
 *   POST   /email/imap/sync           pull new mail now
 *
 * No secrets in source. Everything comes from environment variables:
 *   EMAIL_SEND_TRANSPORT      'smtp' | 'resend' (default 'resend')
 *     - 'smtp'   -> the Directus mailer, i.e. your EMAIL_TRANSPORT / EMAIL_SMTP_* settings
 *     - 'resend' -> RESEND_API_KEY and the Resend HTTP API
 *   EMAIL_FROM                fallback sender, and the SMTP envelope sender
 *   EMAIL_SEND_TIMEOUT_MS     per-message send timeout (default 30000)
 *   EMAIL_ATTACHMENTS_FOLDER  directus_folders id attachments are stored in. Keep it
 *                             out of every permission's readable-folder list: access
 *                             is granted per message by the download route instead
 *   EMAIL_MAX_ATTACHMENT_BYTES  total per message (default 26214400, i.e. 25 MB)
 *   EMAIL_SEND_ALLOWED_ROLES  optional allowlist of role IDs that may send
 *   RESEND_API_KEY            only for the 'resend' transport
 *   EMAIL_INBOUND_USER        HTTP Basic credentials the inbound webhook must present
 *   EMAIL_INBOUND_PASS
 *   EMAIL_INBOUND_ALLOWED_IPS optional comma-separated allowlist for that webhook
 *
 * The inbound route speaks Postmark's Inbound JSON. That is a format, not a
 * dependency: any receiver that can POST the same shape works, including a
 * self-hosted SMTP listener.
 */

import { defineEndpoint } from '@directus/extensions-sdk';
import { registerImapRoutes } from './imap/routes'; // IMAP_ROUTES_IMPORT
import { createSharedInboxAccess, isSharedInboxRow } from './shared-inbox';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

// =============================================================================
// Types
// =============================================================================
interface PostmarkInbound {
    FromName?: string;
    From: string;
    FromFull?: { Email: string; Name?: string };
    To: string;
    ToFull?: Array<{ Email: string; Name?: string; MailboxHash?: string }>;
    Cc?: string;
    CcFull?: Array<{ Email: string; Name?: string }>;
    Bcc?: string;
    BccFull?: Array<{ Email: string; Name?: string }>;
    OriginalRecipient?: string;
    Subject?: string;
    MessageID: string;
    ReplyTo?: string;
    MailboxHash?: string;
    Date?: string;
    TextBody?: string;
    HtmlBody?: string;
    StrippedTextReply?: string;
    Tag?: string;
    Headers?: Array<{ Name: string; Value: string }>;
    Attachments?: Array<{
        Name: string;
        Content: string; // base64
        ContentType: string;
        ContentLength: number;
        ContentID?: string;
    }>;
}

interface SendEmailBody {
    to: string | string[] | Array<{ email: string; name?: string }>;
    cc?: string | string[];
    bcc?: string | string[];
    reply_to?: string;
    subject: string;
    html?: string;
    text?: string;
    in_reply_to?: string;
    thread_id?: string;
    tenant?: string;
    is_internal?: boolean;
    /** Inline attachments, base64. Small ones only: the whole JSON body is
     *  subject to Directus's MAX_PAYLOAD_SIZE, 1 MB by default. */
    attachments?: Array<{ filename: string; content: string; content_type?: string }>;
    /** Attachments that already exist in directus_files. Preferred: these travel
     *  as ids, so the message body stays small and the real ceiling becomes the
     *  mail relay rather than the JSON payload limit. */
    attachment_ids?: string[];
}

// =============================================================================
// Helpers
// =============================================================================
function getHeader(headers: Array<{ Name: string; Value: string }> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const lower = name.toLowerCase();
    return headers.find(h => h.Name.toLowerCase() === lower)?.Value;
}

function parseReferences(refs: string | undefined): string[] {
    if (!refs) return [];
    return refs.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function normalizeMessageId(id: string | undefined | null): string | null {
    if (!id) return null;
    const trimmed = id.trim();
    if (!trimmed) return null;
    // Ensure exactly one pair of angle brackets
    const stripped = trimmed.replace(/^<+|>+$/g, '');
    return `<${stripped}>`;
}

function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

function basicAuthOk(req: any, expectedUser: string, expectedPass: string): boolean {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string' || !header.startsWith('Basic ')) return false;
    try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep < 0) return false;
        const user = decoded.slice(0, sep);
        const pass = decoded.slice(sep + 1);
        return safeEq(user, expectedUser) && safeEq(pass, expectedPass);
    } catch {
        return false;
    }
}

function clientIp(req: any): string {
    const xff = (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
    return xff || req.socket?.remoteAddress || req.ip || '';
}

function ipAllowed(req: any, allowed: string[]): boolean {
    if (allowed.length === 0) return true;
    const ip = clientIp(req);
    return allowed.some(a => ip === a || ip.endsWith(a));
}

function toAddrArray(v: string | string[] | Array<{ email: string; name?: string }> | undefined):
    Array<{ email: string; name?: string }> {
    if (!v) return [];
    if (Array.isArray(v)) {
        return v.map(item => typeof item === 'string' ? { email: item } : item);
    }
    return v.split(',').map(s => s.trim()).filter(Boolean).map(email => ({ email }));
}

function resendAddr(a: { email: string; name?: string }): string {
    return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** Envelope recipients, lower-cased and de-duplicated, preserving order. */
function dedupeAddresses(list: Array<{ email: string; name?: string }>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of list) {
        const email = (a?.email || '').trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(email);
    }
    return out;
}

/**
 * Reject if `promise` doesn't settle within `ms`.
 *
 * The Directus 12.x mailer exposes no timeout knob (it only reads
 * EMAIL_SMTP_{HOST,PORT,USER,PASSWORD,SECURE,IGNORE_TLS,NAME,POOL,TLS_*}), so a
 * stalled relay blocks the request forever: a single send has been seen to hold
 * a request open for most of a day. This bounds it, so the caller gets a 502 and
 * the outbox row is marked failed instead of the request hanging.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

function csvEnv(value: unknown): string[] {
    if (value == null) return [];
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [String(value).trim()].filter(Boolean);
}

// =============================================================================
// Endpoint
// =============================================================================
export default defineEndpoint({
    id: 'email',
    handler: (router, { services, getSchema, env, logger, database }) => {
        const { ItemsService, FilesService, MailService, AssetsService } = services as any;

        // Per-user IMAP mailbox: /email/imap/* (see ./imap/routes.ts). IMAP_ROUTES_REGISTER
        registerImapRoutes(router, { services, getSchema, env: env as Record<string, unknown>, logger, database });

        // Who may reach the shared info@ mailbox (see ./shared-inbox.ts).
        const sharedInbox = createSharedInboxAccess({ database, env: env as Record<string, unknown>, logger });

        // 'smtp'  -> Directus mailer (nodemailer over EMAIL_TRANSPORT / EMAIL_SMTP_*)
        // 'resend'-> legacy Resend HTTP API. Default stays 'resend' so behavior
        //            only changes when EMAIL_SEND_TRANSPORT is set explicitly.
        const sendTransport = String(env.EMAIL_SEND_TRANSPORT ?? 'resend').trim().toLowerCase();

        // Upper bound for a single provider send. Optional override:
        // EMAIL_SEND_TIMEOUT_MS (defaults to 30s).
        const sendTimeoutMs = Number(env.EMAIL_SEND_TIMEOUT_MS ?? 30_000) || 30_000;

        // Where files attached while composing are stored. Keep this folder OUT of
        // any permission's readable-folder list: attachments are reached through
        // GET /email/message/:id/attachment/:fileId, which checks the caller can
        // read the parent message. Putting it in a readable folder would expose
        // every attachment to everyone holding that policy.
        const attachmentsFolder = (env.EMAIL_ATTACHMENTS_FOLDER as string | undefined) || null;

        // Total bytes per message. The relay here advertises SIZE 52428800 and MIME
        // base64 inflates by ~1.37x, so ~36 MB is the hard ceiling; 25 MB is what
        // most receivers accept.
        const maxAttachmentBytes = Number(env.EMAIL_MAX_ATTACHMENT_BYTES ?? 26_214_400) || 26_214_400;

        /**
         * Status bookkeeping must never throw.
         *
         * A user policy typically grants update on is_read/read_at only, so
         * these writes go through a system-level service. Even so, wrap them:
         * a throw on the success path would turn a delivered message into a
         * 502, and a throw inside the catch block escapes the handler entirely
         * — that is the unhandledRejection that left requests hanging with no
         * HTTP response at all.
         */
        async function safeUpdate(svc: any, id: string, patch: Record<string, unknown>, what: string) {
            try {
                await svc.updateOne(id, patch);
            } catch (err) {
                logger.error({ err, id }, `email-send: could not ${what} (bookkeeping only, delivery unaffected)`);
            }
        }

        /**
         * Mirror an outgoing message into the recipients' Directus inbox.
         *
         * External sends only ever wrote the sender's row in `emails`, so a
         * recipient who is also a Directus user saw nothing in /email/inbox —
         * the message existed only in their external mailbox. Internal sends
         * already fan out this way; this brings external sends in line.
         *
         * Uses system-level services (no accountability) because the recipient,
         * not the sender, owns the new row.
         */
        async function fanOutToInbox(opts: {
            schema: any;
            senderId: string;
            senderAddress: string;
            senderName: string | null;
            toRecipients: Array<{ email: string; name?: string }>;
            ccRecipients: Array<{ email: string; name?: string }>;
            attachmentIds?: string[];
            subject: string;
            bodyHtml: string | null;
            bodyText: string | null;
            messageId: string;
            inReplyTo: string | null;
            threadId: string;
            tenant: string | null;
        }): Promise<string[]> {
            const addresses = [...new Set(
                [...opts.toRecipients, ...opts.ccRecipients]
                    .map(r => (r.email || '').toLowerCase().trim())
                    .filter(Boolean)
            )];
            if (addresses.length === 0) return [];

            // Case-insensitive match. A plain whereIn on the column would be
            // case-sensitive on PostgreSQL; comparing lower(email) against the
            // already-lowercased list keeps it portable across the databases
            // Directus supports.
            const matched: Array<{ id: string; email: string; first_name: string | null; last_name: string | null }> =
                await database('directus_users')
                    .select('id', 'email', 'first_name', 'last_name')
                    .whereIn(database.raw('lower(??)', ['email']), addresses)
                    .andWhere('status', 'active');

            if (matched.length === 0) return [];

            const inboxSvc = new ItemsService('inbox_email', { schema: opts.schema, knex: database });
            const inboxIds: string[] = [];

            for (const u of matched) {
                // Don't hand the sender a copy of their own message (self-cc).
                if (u.id === opts.senderId) continue;

                // Idempotency: the same message could also arrive through the
                // inbound webhook if mail routing ever sends it back here.
                const dupe = await inboxSvc.readByQuery({
                    filter: { message_id: { _eq: opts.messageId }, owner: { _eq: u.id } },
                    fields: ['id'],
                    limit: 1,
                });
                if (dupe[0]) continue;

                const id = await inboxSvc.createOne({
                    source: 'smtp',
                    from_user: opts.senderId,
                    from_address: opts.senderAddress,
                    from_name: opts.senderName,
                    // To and Cc are kept apart: folding them together made
                    // everyone look like a direct recipient and left every
                    // mirrored message with an empty Cc list.
                    to_addresses: opts.toRecipients,
                    cc_addresses: opts.ccRecipients,
                    subject: opts.subject,
                    body_html: opts.bodyHtml,
                    body_text: opts.bodyText,
                    message_id: opts.messageId,
                    in_reply_to: opts.inReplyTo,
                    // Same thread_id as the `emails` row keeps GET /email/threads/:id coherent.
                    thread_id: opts.threadId,
                    owner: u.id,
                    tenant: opts.tenant,
                    is_internal: false,
                    is_read: false,
                    received_at: new Date().toISOString(),
                    // Same files, linked again from the recipient's copy. The
                    // rows point at one stored file, not a duplicate of it.
                    attachments: attachmentLinks(opts.attachmentIds ?? []),
                });
                inboxIds.push(id);
            }

            return inboxIds;
        }

        /**
         * Turn directus_files ids into something a mail transport can send.
         *
         * Reading goes through AssetsService: the endpoint context exposes no
         * storage manager, and importing one would bundle a second copy with its
         * own cache instead of reusing the API's. Passing the caller's
         * accountability makes Directus enforce their read permission, so nobody
         * can attach a file they cannot see.
         *
         * The stream is opened lazily. MailService can retry a send, and a stream
         * is only good for one pass.
         */
        async function resolveAttachments(opts: {
            schema: any;
            accountability: any;
            ids: string[];
            inlineBytes: number;
        }): Promise<{
            resolved: Array<{ id: string; filename: string; contentType: string; size: number; open: () => Promise<any> }>;
            total: number;
        }> {
            const ids = [...new Set((opts.ids ?? []).filter(Boolean))];
            if (ids.length === 0) return { resolved: [], total: opts.inlineBytes };

            const assetsSvc = new AssetsService({
                schema: opts.schema,
                knex: database,
                accountability: opts.accountability,
            });

            const resolved = [];
            let total = opts.inlineBytes;

            for (const id of ids) {
                // deferStream = true, so `stream` is a thunk, not an open stream.
                const { stream, file, stat } = await assetsSvc.getAsset(id, null, undefined, true);
                const size = Number(stat?.size ?? file?.filesize ?? 0);
                total += size;
                resolved.push({
                    id,
                    filename: file?.filename_download || file?.title || id,
                    contentType: file?.type || 'application/octet-stream',
                    size,
                    open: stream as () => Promise<any>,
                });
            }

            return { resolved, total };
        }

        /** Junction rows for an `attachments` M2M write. Declared as a function so
         *  it is hoisted above fanOutToInbox, which uses it. */
        function attachmentLinks(ids: string[]) {
            return [...new Set((ids ?? []).filter(Boolean))].map(id => ({ directus_files_id: id }));
        }

        // -------------------------------------------------------------------
        // GET /email/config — what the compose screen needs to know
        // -------------------------------------------------------------------
        router.get('/config', (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized', message: 'Not authenticated.' });
            }
            return res.json({
                attachments_folder: attachmentsFolder,
                max_attachment_bytes: maxAttachmentBytes,
            });
        });

        // -------------------------------------------------------------------
        // GET /email/health
        // -------------------------------------------------------------------
        router.get('/health', (_req: any, res: any) => {
            res.json({
                ok: true,
                inbound: Boolean(env.EMAIL_INBOUND_USER && env.EMAIL_INBOUND_PASS),
                send: sendTransport === 'smtp'
                    ? Boolean(env.EMAIL_SMTP_HOST && env.EMAIL_FROM)
                    : Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
                send_transport: sendTransport,
            });
        });

        // -------------------------------------------------------------------
        // GET /email/recipients — people this user can write to
        // -------------------------------------------------------------------
        router.get('/recipients', async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized', message: 'Not authenticated.' });
            }
            try {
                const schema = await getSchema();
                // System-level on purpose. A typical non-admin policy restricts
                // directus_users reads to the current user, which would leave the
                // compose picker able to suggest only the sender themself. Only the
                // fields needed to address a message are exposed — see the README,
                // this is a deliberate trade-off.
                const usersSvc = new ItemsService('directus_users', { schema, knex: database });
                const users = await usersSvc.readByQuery({
                    filter: { status: { _eq: 'active' } },
                    fields: ['id', 'email', 'first_name', 'last_name'],
                    sort: ['first_name', 'last_name'],
                    limit: 500,
                });
                return res.json({ data: (users ?? []).filter((u: any) => !!u.email) });
            } catch (err: any) {
                logger.error({ err }, 'email-recipients: failed');
                return res.status(500).json({ error: 'internal_error', message: err?.message });
            }
        });

        // -------------------------------------------------------------------
        // GET /email/message/:id/body — the message body as its own document
        //
        // The viewer used to inline the HTML with <iframe srcdoc>, which
        // inherits the Directus app's Content-Security-Policy. That policy
        // allows images only from 'self' and a short host allowlist, so every
        // remote image in a real HTML email rendered broken.
        //
        // Serving the body as a document of its own lets it carry a policy
        // written for mail — images from anywhere, and nothing else at all —
        // instead of loosening the whole admin app. The iframe keeps
        // sandbox="", so this is belt and braces: no scripts either way.
        // -------------------------------------------------------------------
        router.get('/message/:id/body', async (req: any, res: any) => {
            if (!req.accountability?.user) return res.status(401).send('');

            const collection = req.query.kind === 'sent' ? 'emails' : 'inbox_email';
            try {
                const schema = await getSchema();
                // Accountability on purpose: ownership is then enforced by the
                // user's own policy, so nobody can read someone else's mail by
                // guessing an id.
                const svc = new ItemsService(collection, {
                    schema,
                    knex: database,
                    accountability: req.accountability,
                });
                const row = await svc.readOne(req.params.id, { fields: ['body_html', 'body_text'] });

                const escapeHtml = (s: string) => s
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                // Viewers open the message at its full height in one go, which only works
                // if every image has loaded by the time the frame fires `load`: lazy ones
                // wait for a viewport they would never scroll into. EAGER_IMAGES
                const eager = (html: string) =>
                    html.replace(/\sloading\s*=\s*(["']?)lazy\1/gi, ' loading=$1eager$1');
                // What a mail client drops before showing a message. The frame's
                // sandbox and CSP block all of it anyway; removing it first keeps
                // the browser console free of one warning per blocked script or
                // stylesheet. The sandbox and CSP stay the actual protection.
                // Event-handler attributes (onload, onclick…), parsed attribute by
                // attribute so quoted values such as alt="someone online=1" survive.
                const noHandlers = (html: string) => html.replace(/<[a-z][a-z0-9-]*\b[^>]*>/gi, tag =>
                    tag.replace(/(\s+)([^\s"'=<>\/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
                        (m: string, _sp: string, name: string) => (/^on/i.test(name) ? '' : m)));
                const inert = (html: string) => noHandlers(html
                    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
                    .replace(/<script\b[^>]*>/gi, '')
                    .replace(/<(iframe|object|embed|applet|frameset)\b[\s\S]*?<\/\1\s*>/gi, '')
                    .replace(/<(iframe|object|embed|frame|base)\b[^>]*>/gi, '')
                    .replace(/<link\b[^>]*>/gi, '')
                    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
                    .replace(/@import\s+[^;]+;/gi, '')
                    .replace(/(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2'));
                const body = row?.body_html
                    ? eager(inert(row.body_html))
                    : `<pre>${escapeHtml(row?.body_text ?? '')}</pre>`;

                const html = `<!doctype html><html><head><meta charset="utf-8">`
                    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
                    + `<style>`
                    + `html,body{margin:0;padding:12px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;background:#fff;}`
                    + `img{max-width:100%;height:auto;}`
                    + `pre{font-family:ui-monospace,monospace;white-space:pre-wrap;margin:0;}`
                    + `table{max-width:100%;}`
                    + `</style></head><body>${body}</body></html>`;

                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; "
                    + "img-src https: http: data: cid:; "
                    + "style-src 'unsafe-inline' data:; "
                    + "font-src data: https:; "
                    + "frame-ancestors 'self'");
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.setHeader('Cache-Control', 'private, max-age=60');
                return res.send(html);
            } catch (err: any) {
                logger.warn({ err, id: req.params.id, collection }, 'email-body: not readable');
                return res.status(404).send('');
            }
        });

        // -------------------------------------------------------------------
        // Attachments of one message
        //
        //   GET /email/message/:id/attachments           list (id, name, type, size)
        //   GET /email/message/:id/attachment/:fileId     download one
        //                              ?inline=1          open PDFs/images in the browser
        //   both take ?kind=sent for the `emails` store
        //
        // Attachments are stored in a folder that no permission grants read on,
        // so /assets/:id is closed to everyone but the uploader. Access is
        // decided per message instead: the parent is read with the caller's own
        // accountability, so their policy answers "is this your mail?", and the
        // file must actually be attached to that message. Messages of the shared
        // info@ mailbox additionally require one of EMAIL_SHARED_INBOX_ROLES
        // (Administrativo, Administrator), whatever the policies say. Only then
        // are the bytes served, with a system-level service.
        //
        // The alternative — parking attachments in a folder the policy can read —
        // would expose every attachment in the instance to everyone holding that
        // policy, through the file library.
        // -------------------------------------------------------------------
        async function authorizeAttachments(req: any): Promise<
            | { ok: true; fileIds: string[]; shared: boolean }
            | { ok: false; status: number }
        > {
            if (!req.accountability?.user) return { ok: false, status: 401 };
            const collection = req.query.kind === 'sent' ? 'emails' : 'inbox_email';
            const schema = await getSchema();

            let parent: any;
            try {
                const parentSvc = new ItemsService(collection, {
                    schema,
                    knex: database,
                    accountability: req.accountability,
                });
                parent = await parentSvc.readOne(req.params.id, {
                    fields: collection === 'inbox_email'
                        ? ['id', 'owner', 'source', 'attachments.directus_files_id']
                        : ['id', 'attachments.directus_files_id'],
                });
            } catch (err: any) {
                logger.warn({ err, id: req.params.id, collection }, 'email-attachment: parent not readable');
                return { ok: false, status: 404 };
            }
            if (!parent) return { ok: false, status: 404 };

            const shared = collection === 'inbox_email' && isSharedInboxRow(parent);
            if (shared && !(await sharedInbox.canAccess(req.accountability))) {
                return { ok: false, status: 403 };
            }

            const fileIds: string[] = (parent.attachments ?? [])
                .map((a: any) => a?.directus_files_id?.id ?? a?.directus_files_id)
                .filter(Boolean)
                .map(String);
            return { ok: true, fileIds, shared };
        }

        router.get('/message/:id/attachments', async (req: any, res: any) => {
            try {
                const auth = await authorizeAttachments(req);
                if (!auth.ok) return res.status(auth.status).json({ error: auth.status === 403 ? 'forbidden' : 'not_found' });
                if (!auth.fileIds.length) return res.json({ data: [], shared: auth.shared });

                const schema = await getSchema();
                const filesSvc = new FilesService({ schema, knex: database, accountability: null });
                const rows: any[] = await filesSvc.readMany(auth.fileIds, {
                    fields: ['id', 'filename_download', 'title', 'type', 'filesize'],
                });
                const byId = new Map(rows.map(r => [String(r.id), r]));
                const data = auth.fileIds
                    .map(id => byId.get(id))
                    .filter(Boolean)
                    .map((f: any) => ({
                        id: f.id,
                        filename: f.filename_download || f.title || 'attachment',
                        type: f.type || 'application/octet-stream',
                        filesize: f.filesize != null ? Number(f.filesize) : null,
                    }));
                res.setHeader('Cache-Control', 'private, no-store');
                return res.json({ data, shared: auth.shared });
            } catch (err: any) {
                logger.warn({ err, id: req.params.id }, 'email-attachments: list failed');
                return res.status(500).json({ error: 'internal' });
            }
        });

        // Types a browser renders without running anything. SVG and HTML stay
        // downloads: they are documents that can carry script.
        const INLINE_SAFE_TYPES = new Set([
            'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain',
        ]);

        router.get('/message/:id/attachment/:fileId', async (req: any, res: any) => {
            try {
                const auth = await authorizeAttachments(req);
                if (!auth.ok) return res.status(auth.status).send('');
                if (!auth.fileIds.includes(String(req.params.fileId))) return res.status(404).send('');

                // System-level on purpose: the caller has just proved their right
                // to this message, and the file itself is deliberately unreadable
                // under their own policy.
                const schema = await getSchema();
                const assetsSvc = new AssetsService({ schema, knex: database, accountability: null });
                const { stream, file } = await assetsSvc.getAsset(req.params.fileId, null, undefined, false);

                const type = String(file?.type || 'application/octet-stream');
                const inline = req.query.inline === '1' && INLINE_SAFE_TYPES.has(type.toLowerCase());
                const filename = String(file?.filename_download || file?.title || 'attachment').replace(/[\r\n]/g, ' ');
                // ASCII fallback plus RFC 5987 form: Node rejects non-ASCII header
                // bytes outright, which broke names like "orçamento.pdf".
                const asciiName = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_') || 'attachment';
                const disposition = inline ? 'inline' : 'attachment';

                res.setHeader('Content-Type', type);
                res.setHeader(
                    'Content-Disposition',
                    `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                );
                if (file?.filesize) res.setHeader('Content-Length', String(file.filesize));
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Cache-Control', 'private, max-age=60');

                stream.on('error', (err: any) => {
                    logger.warn({ err, fileId: req.params.fileId }, 'email-attachment: stream failed');
                    res.destroy();
                });
                return stream.pipe(res);
            } catch (err: any) {
                logger.warn({ err, id: req.params.id }, 'email-attachment: not readable');
                return res.status(404).send('');
            }
        });

        // -------------------------------------------------------------------
        // POST /email/inbound/postmark
        // -------------------------------------------------------------------
        router.post('/inbound/postmark', async (req: any, res: any) => {
            const inboundUser = env.EMAIL_INBOUND_USER as string | undefined;
            const inboundPass = env.EMAIL_INBOUND_PASS as string | undefined;

            if (!inboundUser || !inboundPass) {
                logger.error('email-inbound: EMAIL_INBOUND_USER / EMAIL_INBOUND_PASS not set');
                return res.status(503).json({ error: 'service_unconfigured' });
            }

            if (!basicAuthOk(req, inboundUser, inboundPass)) {
                logger.warn(`email-inbound: bad basic auth from ${clientIp(req)}`);
                return res.status(401).json({ error: 'unauthorized' });
            }

            const allowlist = csvEnv(env.EMAIL_INBOUND_ALLOWED_IPS);

            if (!ipAllowed(req, allowlist)) {
                logger.warn(`email-inbound: rejected IP ${clientIp(req)}`);
                return res.status(403).json({ error: 'forbidden' });
            }

            const payload = req.body as PostmarkInbound;
            if (!payload || !payload.MessageID || !payload.From) {
                return res.status(400).json({ error: 'invalid_payload' });
            }

            const schema = await getSchema();
            const inboxSvc = new ItemsService('inbox_email', { schema, knex: database });
            const aliasesSvc = new ItemsService('email_aliases', { schema, knex: database });
            const filesSvc = new FilesService({ schema, knex: database });

            try {
                // ----- Idempotency: skip duplicates -----
                const existing = await inboxSvc.readByQuery({
                    filter: {
                        source: { _eq: 'postmark' },
                        provider_message_id: { _eq: payload.MessageID },
                    },
                    fields: ['id'],
                    limit: 1,
                });
                if (existing[0]) {
                    return res.status(200).json({ status: 'duplicate', id: existing[0].id });
                }

                // ----- Recipient resolution via email_aliases -----
                // Envelope recipient first: when mail is forwarded to this system,
                // that is the address whose forwarder fired, and it is the only
                // reliable signal when the person was Bcc'd or the mail went to a
                // list. Then every To and Cc address from the headers.
                //
                // A message addressed to more than one of our people has to land in
                // each of their inboxes, so every match is collected — this loop used
                // to stop at the first one, which silently dropped the other
                // recipients.
                const recipientCandidates: string[] = [
                    payload.OriginalRecipient,
                    ...(payload.ToFull ?? []).map(a => a.Email),
                    payload.To,
                    ...(payload.CcFull ?? []).map(a => a.Email),
                    payload.Cc,
                ].map(s => (s || '').toLowerCase().trim()).filter(Boolean);
                // Deduplicate
                const uniqueCandidates = [...new Set(recipientCandidates)];

                const matchedOwners = new Map<string, string | null>(); // owner -> tenant
                let unownedTenant: string | null = null;

                for (const candidate of uniqueCandidates) {
                    let hit = (await aliasesSvc.readByQuery({
                        filter: { alias: { _eq: candidate }, is_active: { _eq: true } },
                        fields: ['owner', 'tenant'],
                        limit: 1,
                    }))[0];

                    // Try wildcard domain match
                    if (!hit) {
                        const domain = candidate.split('@')[1];
                        if (domain) {
                            hit = (await aliasesSvc.readByQuery({
                                filter: { alias: { _eq: `*@${domain}` }, is_active: { _eq: true } },
                                fields: ['owner', 'tenant'],
                                limit: 1,
                            }))[0];
                        }
                    }

                    if (!hit) continue;
                    if (hit.tenant && !unownedTenant) unownedTenant = hit.tenant;
                    // An alias with no owner is a deliberate "nobody in particular",
                    // which is how a shared mailbox is modelled: it must not create a
                    // row in anyone's personal inbox.
                    if (hit.owner) matchedOwners.set(hit.owner, hit.tenant ?? null);
                }

                // No match at all still stores one unowned row, so inbound mail is
                // never silently discarded.
                const targets: Array<{ owner: string | null; tenant: string | null }> =
                    matchedOwners.size > 0
                        ? [...matchedOwners].map(([owner, tenant]) => ({ owner, tenant }))
                        : [{ owner: null, tenant: unownedTenant }];

                // ----- Threading -----
                const messageId = normalizeMessageId(
                    getHeader(payload.Headers, 'Message-ID') || payload.MessageID
                );
                const inReplyTo = normalizeMessageId(getHeader(payload.Headers, 'In-Reply-To'));
                const refs = parseReferences(getHeader(payload.Headers, 'References'));

                let threadId: string | null = null;
                const candidates = [inReplyTo, ...refs].filter(Boolean) as string[];
                if (candidates.length > 0) {
                    // Search both tables for the thread root
                    const sentSvc = new ItemsService('emails', { schema, knex: database });
                    const inboxParents = await inboxSvc.readByQuery({
                        filter: { message_id: { _in: candidates } },
                        fields: ['thread_id'],
                        limit: 1,
                    });
                    if (inboxParents[0]?.thread_id) {
                        threadId = inboxParents[0].thread_id;
                    } else {
                        const sentParents = await sentSvc.readByQuery({
                            filter: { message_id: { _in: candidates } },
                            fields: ['thread_id'],
                            limit: 1,
                        });
                        if (sentParents[0]?.thread_id) threadId = sentParents[0].thread_id;
                    }
                }
                if (!threadId) threadId = randomUUID();

                // ----- Attachments → directus_files -----
                const storage = csvEnv(env.STORAGE_LOCATIONS)[0] || 'local';
                const attachmentIds: string[] = [];

                for (const att of payload.Attachments ?? []) {
                    try {
                        const buffer = Buffer.from(att.Content, 'base64');
                        const stream = Readable.from(buffer);
                        const fileId = await filesSvc.uploadOne(stream, {
                            filename_download: att.Name,
                            type: att.ContentType,
                            storage,
                            title: att.Name,
                            filesize: buffer.length,
                            // Without a folder these land at the root of the file
                            // library with uploaded_by null, which under a typical
                            // policy makes them readable by nobody but an admin —
                            // the download link on a received message then 403s.
                            ...(attachmentsFolder ? { folder: attachmentsFolder } : {}),
                        });
                        attachmentIds.push(fileId);
                    } catch (err) {
                        logger.error({ err, filename: att.Name }, 'email-inbound: attachment upload failed');
                        // keep going — partial-success is better than dropping the email
                    }
                }

                // ----- Persist: one row per recipient of ours -----
                const common = {
                    source: 'postmark',
                    from_address: payload.From,
                    from_name: payload.FromName || payload.FromFull?.Name || null,
                    to_addresses: (payload.ToFull ?? [{ Email: payload.To }]).map(a => ({
                        email: a.Email,
                        name: a.Name || undefined,
                    })),
                    cc_addresses: (payload.CcFull ?? []).map(a => ({ email: a.Email, name: a.Name || undefined })),
                    reply_to: payload.ReplyTo || null,
                    subject: payload.Subject || '(no subject)',
                    body_html: payload.HtmlBody || null,
                    body_text: payload.TextBody || null,
                    message_id: messageId,
                    in_reply_to: inReplyTo,
                    references_header: refs.length ? refs.join(' ') : null,
                    thread_id: threadId,
                    provider_message_id: payload.MessageID,
                    is_internal: false,
                    is_read: false,
                    received_at: payload.Date ? new Date(payload.Date).toISOString() : new Date().toISOString(),
                    raw_payload: payload,
                };

                const storedIds: string[] = [];
                for (const target of targets) {
                    // A message sent from here may already have been mirrored into this
                    // owner's inbox by the send fan-out. The provider_message_id check
                    // above only catches the sender's own re-deliveries, so match on
                    // Message-ID + owner too.
                    if (messageId && target.owner) {
                        const mirrored = await inboxSvc.readByQuery({
                            filter: { message_id: { _eq: messageId }, owner: { _eq: target.owner } },
                            fields: ['id'],
                            limit: 1,
                        });
                        if (mirrored[0]) {
                            storedIds.push(mirrored[0].id);
                            continue;
                        }
                    }

                    storedIds.push(await inboxSvc.createOne({
                        ...common,
                        owner: target.owner,
                        tenant: target.tenant,
                        attachments: attachmentIds.map(fid => ({ directus_files_id: fid })),
                    }));
                }

                const ownerLabel = targets.map(t => t.owner ?? '(unassigned)').join(',');
                logger.info(
                    `email-inbound: stored ${storedIds.join(',')} owner=${ownerLabel} thread=${threadId}`
                );
                return res.status(200).json({
                    status: 'ok',
                    id: storedIds[0],
                    ids: storedIds,
                    thread_id: threadId,
                });
            } catch (err: any) {
                logger.error({ err }, 'email-inbound: failed');
                // Return 500 so Postmark retries (up to its default schedule).
                // Switch to 200 if you'd rather not retry on persistent errors.
                return res.status(500).json({ error: 'internal_error', message: err?.message ?? 'unknown' });
            }
        });

        // -------------------------------------------------------------------
        // POST /email/send
        // -------------------------------------------------------------------
        router.post('/send', async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized' });
            }

            const allowedRoles = csvEnv(env.EMAIL_SEND_ALLOWED_ROLES);

            if (allowedRoles.length > 0
                && !req.accountability.admin
                && !allowedRoles.includes(req.accountability.role)) {
                return res.status(403).json({
                    error: 'forbidden',
                    // `message` is what the UI surfaces (Compose.vue reads
                    // response.data.message); without it axios only yields
                    // "Request failed with status code 403".
                    message: 'Your role is not allowed to send email.',
                });
            }

            const body = req.body as SendEmailBody;
            if (!body?.to || !body?.subject || (!body.html && !body.text)) {
                return res.status(400).json({
                    error: 'missing_required_fields',
                    required: ['to', 'subject', 'html or text'],
                    message: 'Missing required fields: recipient, subject and a message body.',
                });
            }

            const apiKey = env.RESEND_API_KEY as string | undefined;
            const from = env.EMAIL_FROM as string | undefined;
            if (sendTransport === 'smtp') {
                if (!env.EMAIL_SMTP_HOST || !from) {
                    const missing = [!env.EMAIL_SMTP_HOST ? 'EMAIL_SMTP_HOST' : null, !from ? 'EMAIL_FROM' : null].filter(Boolean);
                    return res.status(503).json({
                        error: 'service_unconfigured',
                        missing,
                        message: `Email is not configured on this server (missing: ${missing.join(', ')}).`,
                    });
                }
            } else if (!apiKey || !from) {
                const missing = [!apiKey ? 'RESEND_API_KEY' : null, !from ? 'EMAIL_FROM' : null].filter(Boolean);
                return res.status(503).json({
                    error: 'service_unconfigured',
                    missing,
                    message: `Email is not configured on this server (missing: ${missing.join(', ')}).`,
                });
            }

            const schema = await getSchema();
            const emailsSvc = new ItemsService('emails', {
                schema,
                knex: database,
                accountability: req.accountability,
            });
            // Status bookkeeping is server-owned: user policies only allow updating is_read/read_at.
            const emailsSysSvc = new ItemsService('emails', { schema, knex: database });

            // ----- Per-user sender resolution via email_aliases -----
            const aliasesSvc = new ItemsService('email_aliases', { schema, knex: database });
            let senderAddress = from;
            let senderName: string | null = null;
            try {
                const userAliases = await aliasesSvc.readByQuery({
                    filter: {
                        owner: { _eq: req.accountability.user },
                        is_active: { _eq: true },
                        // email_aliases holds two different things: addresses that
                        // route mail TO a user (including receive-only forwarder
                        // targets on a domain your relay does not host) and the
                        // address the user sends AS. Sending as a receive-only
                        // address is refused by most relays with
                        //   550 unable to send email from this domain
                        can_send: { _eq: true },
                    },
                    fields: ['alias', 'display_name'],
                    // A user can legitimately own several sendable aliases; pick the
                    // same one every time instead of whatever the database returns
                    // first, which used to make the From address a coin flip.
                    sort: ['alias'],
                    limit: 1,
                });
                if (userAliases[0]) {
                    senderAddress = userAliases[0].alias;
                    senderName = userAliases[0].display_name ?? null;
                }
            } catch (err) {
                logger.warn({ err }, 'email-send: alias lookup failed, using default FROM');
            }
            const fromFormatted = senderName
                ? `${senderName} <${senderAddress}>`
                : senderAddress;

            // ----- Thread resolution -----
            let threadId = body.thread_id;
            if (!threadId && body.in_reply_to) {
                const normalizedInReply = normalizeMessageId(body.in_reply_to);
                if (normalizedInReply) {
                    const parents = await emailsSvc.readByQuery({
                        filter: { message_id: { _eq: normalizedInReply } },
                        fields: ['thread_id'],
                        limit: 1,
                    });
                    threadId = parents[0]?.thread_id;
                }
            }
            if (!threadId) threadId = randomUUID();

            // ----- Generate our Message-ID -----
            const localDomain = senderAddress.split('@')[1] || 'localhost';
            const messageId = `<${randomUUID()}@${localDomain}>`;

            const toAddrs = toAddrArray(body.to);
            const ccAddrs = toAddrArray(body.cc);
            const bccAddrs = toAddrArray(body.bcc);

            if (toAddrs.length === 0) {
                return res.status(400).json({
                    error: 'invalid_to',
                    message: 'No valid recipient was given.',
                });
            }

            // ----- Attachments -----
            const inlineBytes = (body.attachments ?? [])
                .reduce((n, a) => n + Math.floor((a.content?.length ?? 0) * 3 / 4), 0);
            let attachmentsResolved: Array<{ id: string; filename: string; contentType: string; size: number; open: () => Promise<any> }> = [];
            try {
                const r = await resolveAttachments({
                    schema,
                    accountability: req.accountability,
                    ids: body.attachment_ids ?? [],
                    inlineBytes,
                });
                attachmentsResolved = r.resolved;
                if (r.total > maxAttachmentBytes) {
                    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
                    return res.status(413).json({
                        error: 'attachments_too_large',
                        bytes: r.total,
                        max_bytes: maxAttachmentBytes,
                        message: `Attachments total ${mb(r.total)} MB, over the ${mb(maxAttachmentBytes)} MB limit.`,
                    });
                }
            } catch (err: any) {
                // A file the sender cannot read, or one that is missing from storage.
                logger.warn({ err }, 'email-send: attachment could not be resolved');
                return res.status(400).json({
                    error: 'invalid_attachment',
                    message: 'An attachment could not be read. It may have been deleted.',
                });
            }

            // Persist 'sending' first so we have an audit row even if the provider fails.
            const emailId = await emailsSvc.createOne({
                direction: 'sent',
                status: 'sending',
                from_address: senderAddress,
                from_name: senderName,
                to_addresses: toAddrs,
                cc_addresses: ccAddrs,
                bcc_addresses: bccAddrs,
                reply_to: body.reply_to ?? null,
                subject: body.subject,
                body_html: body.html ?? null,
                body_text: body.text ?? null,
                message_id: messageId,
                in_reply_to: normalizeMessageId(body.in_reply_to),
                thread_id: threadId,
                provider: sendTransport === 'smtp' ? 'smtp' : 'resend',
                owner: req.accountability.user,
                tenant: body.tenant ?? null,
                is_internal: body.is_internal ?? false,
                is_read: true,
                // Without this the attachment exists only on the wire: the Sent
                // view and the conversation would both show none.
                attachments: attachmentLinks(body.attachment_ids ?? []),
            });

            try {
                let providerMessageId: string | null = null;

                if (sendTransport === 'smtp') {
                    // ----- Own SMTP smarthost via the Directus mailer -----
                    // Reuses the exact EMAIL_TRANSPORT / EMAIL_SMTP_* config that
                    // already sends Directus system mail — no per-email cost, no
                    // external API. Free and unlimited within the host's limits.
                    const mailSvc = new MailService({ schema, knex: database });

                    // Structured address objects (not "Name <addr>" strings) so
                    // nodemailer RFC-2047-encodes display names (e.g. em-dashes)
                    // instead of the receiving MTA mis-parsing them.
                    const mailAddr = (a: { email: string; name?: string }) =>
                        a.name ? { name: a.name, address: a.email } : a.email;

                    const mailOptions: Record<string, unknown> = {
                        from: senderName
                            ? { name: senderName, address: senderAddress }
                            : senderAddress,
                        to: toAddrs.map(mailAddr),
                        subject: body.subject,
                        messageId,
                        // Envelope sender pinned to the system address (EMAIL_FROM):
                        // relays that do sender verification require it to be a real
                        // mailbox, and display names never belong in the envelope. The
                        // header From above keeps the user's alias, which stays
                        // DMARC-aligned on the same domain, and bounces route to the
                        // system mailbox.
                        // De-duplicated, case-insensitively: the same person in
                        // both To and Cc would otherwise appear twice in RCPT TO,
                        // and a strict relay either delivers two copies or refuses
                        // the repeat.
                        envelope: {
                            from,
                            to: dedupeAddresses([...toAddrs, ...ccAddrs, ...bccAddrs]),
                        },
                    };
                    if (ccAddrs.length) mailOptions.cc = ccAddrs.map(mailAddr);
                    if (bccAddrs.length) mailOptions.bcc = bccAddrs.map(mailAddr);
                    if (body.reply_to) mailOptions.replyTo = body.reply_to;
                    if (body.html) mailOptions.html = body.html;
                    if (body.text) mailOptions.text = body.text;
                    if (body.in_reply_to) {
                        const norm = normalizeMessageId(body.in_reply_to);
                        if (norm) {
                            mailOptions.inReplyTo = norm;
                            mailOptions.references = norm;
                        }
                    }
                    const mailAttachments = [
                        ...(body.attachments ?? []).map(a => ({
                            filename: a.filename,
                            content: Buffer.from(a.content, 'base64'),
                            contentType: a.content_type,
                        })),
                        // nodemailer takes a Readable as `content` and streams it
                        // straight into the MIME part, so nothing is buffered here.
                        ...(await Promise.all(attachmentsResolved.map(async a => ({
                            filename: a.filename,
                            content: await a.open(),
                            contentType: a.contentType,
                        })))),
                    ];
                    if (mailAttachments.length) mailOptions.attachments = mailAttachments;

                    const info = await withTimeout(
                        mailSvc.send(mailOptions),
                        sendTimeoutMs,
                        'smtp send'
                    );
                    providerMessageId = (info && (info as any).messageId) || messageId;
                } else {
                    // ----- Legacy Resend HTTP API -----
                    const headers: Record<string, string> = { 'Message-ID': messageId };
                    if (body.in_reply_to) {
                        const norm = normalizeMessageId(body.in_reply_to);
                        if (norm) {
                            headers['In-Reply-To'] = norm;
                            headers['References'] = norm;
                        }
                    }

                    const resendPayload: Record<string, unknown> = {
                        from: fromFormatted,
                        to: toAddrs.map(resendAddr),
                        subject: body.subject,
                        headers,
                    };
                    if (ccAddrs.length) resendPayload.cc = ccAddrs.map(resendAddr);
                    if (bccAddrs.length) resendPayload.bcc = bccAddrs.map(resendAddr);
                    if (body.reply_to) resendPayload.reply_to = body.reply_to;
                    if (body.html) resendPayload.html = body.html;
                    if (body.text) resendPayload.text = body.text;
                    const resendAttachments = [
                        ...(body.attachments ?? []).map(a => ({
                            filename: a.filename,
                            content: a.content,
                            content_type: a.content_type,
                        })),
                        // Resend's API takes base64 only, so a stored file has to be
                        // read into memory for this transport. The SMTP path streams.
                        ...(await Promise.all(attachmentsResolved.map(async a => {
                            const chunks: Buffer[] = [];
                            for await (const chunk of await a.open()) chunks.push(chunk as Buffer);
                            return {
                                filename: a.filename,
                                content: Buffer.concat(chunks).toString('base64'),
                                content_type: a.contentType,
                            };
                        }))),
                    ];
                    if (resendAttachments.length) resendPayload.attachments = resendAttachments;

                    const resp = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(resendPayload),
                    });

                    if (!resp.ok) {
                        const errText = await resp.text();
                        throw new Error(`Resend ${resp.status}: ${errText.slice(0, 500)}`);
                    }
                    const data = await resp.json() as { id?: string };
                    providerMessageId = data.id ?? null;
                }

                // Delivered. Nothing below may turn a sent message into an error.
                await safeUpdate(emailsSysSvc, emailId, {
                    status: 'sent',
                    provider_message_id: providerMessageId,
                    sent_at: new Date().toISOString(),
                }, 'mark as sent');

                let inboxIds: string[] = [];
                try {
                    inboxIds = await fanOutToInbox({
                        schema,
                        senderId: req.accountability.user,
                        senderAddress,
                        senderName,
                        toRecipients: toAddrs,
                        ccRecipients: ccAddrs,
                        attachmentIds: body.attachment_ids ?? [],
                        subject: body.subject,
                        bodyHtml: body.html ?? null,
                        bodyText: body.text ?? null,
                        messageId,
                        inReplyTo: normalizeMessageId(body.in_reply_to),
                        threadId,
                        tenant: body.tenant ?? null,
                    });
                } catch (err) {
                    logger.warn({ err, emailId }, 'email-send: inbox fan-out failed (message was delivered)');
                }

                return res.status(200).json({
                    status: 'ok',
                    id: emailId,
                    message_id: messageId,
                    thread_id: threadId,
                    provider: sendTransport === 'smtp' ? 'smtp' : 'resend',
                    provider_message_id: providerMessageId,
                    inbox_ids: inboxIds,
                });
            } catch (err: any) {
                // Reached only when the provider itself failed — bookkeeping
                // errors are swallowed by safeUpdate and logged separately.
                logger.error({ err, emailId }, `email-send: ${sendTransport} delivery failed`);
                await safeUpdate(emailsSysSvc, emailId, {
                    status: 'failed',
                    error_message: String(err?.message ?? 'unknown').slice(0, 2000),
                }, 'mark as failed');
                return res.status(502).json({
                    error: 'send_failed',
                    id: emailId,
                    message: err?.message ?? 'The message could not be sent.',
                });
            }
        });

        // -------------------------------------------------------------------
        // GET /email/threads/:id  — unifies emails (sent) + inbox_email (received)
        // RLS-respecting (owner filter applied per service).
        // -------------------------------------------------------------------
        router.get('/threads/:id', async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized' });
            }
            const schema = await getSchema();
            const sentSvc = new ItemsService('emails', {
                schema, knex: database, accountability: req.accountability,
            });
            const inboxSvc = new ItemsService('inbox_email', {
                schema, knex: database, accountability: req.accountability,
            });
            try {
                const [sent, received] = await Promise.all([
                    sentSvc.readByQuery({
                        filter: { thread_id: { _eq: req.params.id } },
                        sort: ['date_created'],
                        fields: [
                            'id', 'direction', 'status', 'from_address', 'from_name',
                            'to_addresses', 'cc_addresses', 'subject', 'body_html', 'body_text',
                            'message_id', 'in_reply_to', 'thread_id', 'date_created', 'sent_at',
                            'is_read', 'is_internal',
                            // Raw FK only: the files are unreadable under the
                            // caller's policy, so expanding them yields null.
                            'attachments.directus_files_id',
                        ],
                    }),
                    inboxSvc.readByQuery({
                        filter: { thread_id: { _eq: req.params.id } },
                        sort: ['date_created'],
                        fields: [
                            'id', 'source', 'from_address', 'from_name', 'from_user',
                            'to_addresses', 'cc_addresses', 'subject', 'body_html', 'body_text',
                            'message_id', 'in_reply_to', 'thread_id', 'date_created', 'received_at',
                            'is_read', 'is_internal',
                            // Raw FK only: the files are unreadable under the
                            // caller's policy, so expanding them yields null.
                            'attachments.directus_files_id',
                        ],
                    }),
                ]);
                // Every id here comes from a message the caller has just been
                // allowed to read, so reading the file rows system-level only
                // exposes metadata for attachments they are entitled to.
                const fileIdOf = (a: any) => a?.directus_files_id?.id ?? a?.directus_files_id ?? null;
                const fileIds = [...new Set(
                    [...sent, ...received].flatMap((r: any) => (r.attachments ?? []).map(fileIdOf)).filter(Boolean),
                )];
                const fileMeta = new Map<string, any>();
                if (fileIds.length) {
                    const filesMetaSvc = new ItemsService('directus_files', { schema, knex: database, accountability: null });
                    const rows = await filesMetaSvc.readByQuery({
                        filter: { id: { _in: fileIds } },
                        fields: ['id', 'filename_download', 'type', 'filesize'],
                        limit: -1,
                    });
                    for (const f of rows) fileMeta.set(f.id, f);
                }
                const hydrate = (r: any) => ({
                    ...r,
                    attachments: (r.attachments ?? [])
                        .map((a: any) => fileMeta.get(fileIdOf(a)))
                        .filter(Boolean)
                        .map((f: any) => ({ directus_files_id: f })),
                });
                const items = [
                    ...sent.map((r: any) => ({ ...hydrate(r), _kind: 'sent' })),
                    ...received.map((r: any) => ({ ...hydrate(r), _kind: 'received' })),
                ].sort((a, b) => {
                    const da = new Date(a.date_created ?? 0).getTime();
                    const db = new Date(b.date_created ?? 0).getTime();
                    return da - db;
                });
                return res.json({ thread_id: req.params.id, items });
            } catch (err: any) {
                logger.error({ err }, 'email-thread: read failed');
                return res.status(500).json({ error: 'internal_error', message: err?.message });
            }
        });

        // -------------------------------------------------------------------
        // POST /email/internal/send  — user-to-user message inside Directus
        // -------------------------------------------------------------------
        router.post('/internal/send', async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized' });
            }

            const body = req.body as {
                to_user?: string | string[];
                subject?: string;
                body_html?: string;
                body_text?: string;
                thread_id?: string;
                in_reply_to?: string;
                tenant?: string;
                attachment_ids?: string[];
            };

            if (!body?.to_user || !body?.subject || (!body.body_html && !body.body_text)) {
                return res.status(400).json({
                    error: 'missing_required_fields',
                    required: ['to_user', 'subject', 'body_html or body_text'],
                });
            }

            const recipients = Array.isArray(body.to_user) ? body.to_user : [body.to_user];
            if (recipients.length === 0) {
                return res.status(400).json({ error: 'invalid_to_user' });
            }

            const schema = await getSchema();
            const usersSvc = new ItemsService('directus_users', { schema, knex: database });
            const sentSvc = new ItemsService('emails', {
                schema, knex: database, accountability: req.accountability,
            });
            const inboxSvc = new ItemsService('inbox_email', { schema, knex: database });

            try {
                const recipientUsers = await usersSvc.readMany(recipients, {
                    fields: ['id', 'email', 'first_name', 'last_name'],
                });
                if (recipientUsers.length !== recipients.length) {
                    return res.status(400).json({ error: 'unknown_recipient' });
                }

                // Resolve threading
                let threadId = body.thread_id;
                const inReplyTo = normalizeMessageId(body.in_reply_to);
                if (!threadId && inReplyTo) {
                    const [hitInbox, hitSent] = await Promise.all([
                        inboxSvc.readByQuery({
                            filter: { message_id: { _eq: inReplyTo } },
                            fields: ['thread_id'], limit: 1,
                        }),
                        sentSvc.readByQuery({
                            filter: { message_id: { _eq: inReplyTo } },
                            fields: ['thread_id'], limit: 1,
                        }),
                    ]);
                    threadId = hitInbox[0]?.thread_id ?? hitSent[0]?.thread_id;
                }
                if (!threadId) threadId = randomUUID();

                const sender = req.accountability.user as string;
                const senderUser = await usersSvc.readOne(sender, {
                    fields: ['id', 'email', 'first_name', 'last_name'],
                });
                const senderAddr = senderUser?.email ?? `${sender}@internal.local`;
                const senderName = [senderUser?.first_name, senderUser?.last_name]
                    .filter(Boolean).join(' ') || senderUser?.email || '';

                const messageId = `<${randomUUID()}@internal.local>`;
                const toAddrs = recipientUsers.map((u: any) => ({
                    email: u.email,
                    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined,
                    user_id: u.id,
                }));

                // 1 row in `emails` (sender's outbox)
                // Nothing leaves the building on this path, so there is no transport
                // to attach to and no size limit to enforce — only the links.
                const internalLinks = attachmentLinks(body.attachment_ids ?? []);

                const sentId = await sentSvc.createOne({
                    direction: 'sent',
                    status: 'sent',
                    attachments: internalLinks,
                    from_address: senderAddr,
                    from_name: senderName || null,
                    to_addresses: toAddrs,
                    cc_addresses: [],
                    bcc_addresses: [],
                    subject: body.subject,
                    body_html: body.body_html ?? null,
                    body_text: body.body_text ?? null,
                    message_id: messageId,
                    in_reply_to: inReplyTo,
                    thread_id: threadId,
                    provider: 'internal',
                    owner: sender,
                    tenant: body.tenant ?? null,
                    is_internal: true,
                    is_read: true,
                    sent_at: new Date().toISOString(),
                });

                // 1 row per recipient in inbox_email
                const inboxIds: string[] = [];
                for (const u of recipientUsers) {
                    const inboxId = await inboxSvc.createOne({
                        source: 'internal',
                        attachments: internalLinks,
                        from_user: sender,
                        from_address: senderAddr,
                        from_name: senderName || null,
                        to_addresses: [{ email: u.email, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined, user_id: u.id }],
                        subject: body.subject,
                        body_html: body.body_html ?? null,
                        body_text: body.body_text ?? null,
                        message_id: messageId,
                        in_reply_to: inReplyTo,
                        thread_id: threadId,
                        owner: u.id,
                        tenant: body.tenant ?? null,
                        is_internal: true,
                        is_read: false,
                        received_at: new Date().toISOString(),
                    });
                    inboxIds.push(inboxId);
                }

                return res.status(200).json({
                    status: 'ok',
                    sent_id: sentId,
                    inbox_ids: inboxIds,
                    thread_id: threadId,
                    message_id: messageId,
                });
            } catch (err: any) {
                logger.error({ err }, 'email-internal-send: failed');
                return res.status(500).json({ error: 'internal_error', message: err?.message });
            }
        });

        // -------------------------------------------------------------------
        // POST /email/inbox/:id/read  &  /unread  — flip is_read for the owner
        // -------------------------------------------------------------------
        const setRead = (value: boolean) => async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized' });
            }
            const schema = await getSchema();
            const inboxSvc = new ItemsService('inbox_email', {
                schema, knex: database, accountability: req.accountability,
            });
            try {
                await inboxSvc.updateOne(req.params.id, {
                    is_read: value,
                    read_at: value ? new Date().toISOString() : null,
                });
                return res.json({ status: 'ok', id: req.params.id, is_read: value });
            } catch (err: any) {
                logger.error({ err, id: req.params.id }, 'email-inbox-read: failed');
                return res.status(500).json({ error: 'internal_error', message: err?.message });
            }
        };
        router.post('/inbox/:id/read', setRead(true));
        router.post('/inbox/:id/unread', setRead(false));

        // -------------------------------------------------------------------
        // DELETE /email/inbox/:id  &  /email/sent/:id — owner-only delete.
        // The role policy intentionally has no delete on these collections;
        // deletion goes through here so only the owner can remove their rows.
        // -------------------------------------------------------------------
        const deleteOwned = (collection: string) => async (req: any, res: any) => {
            if (!req.accountability?.user) {
                return res.status(401).json({ error: 'unauthorized' });
            }
            const schema = await getSchema();
            const svc = new ItemsService(collection, { schema, knex: database });
            let item: any;
            try {
                item = await svc.readOne(req.params.id, { fields: ['id', 'owner'] });
            } catch {
                return res.status(404).json({ error: 'not_found' });
            }
            if (!item || item.owner !== req.accountability.user) {
                return res.status(403).json({ error: 'forbidden' });
            }
            try {
                await svc.deleteOne(req.params.id);
                return res.json({ status: 'ok', id: req.params.id });
            } catch (err: any) {
                logger.error({ err, id: req.params.id, collection }, 'email-delete: failed');
                return res.status(500).json({ error: 'internal_error', message: err?.message });
            }
        };
        router.delete('/inbox/:id', deleteOwned('inbox_email'));
        router.delete('/sent/:id', deleteOwned('emails'));

    },
});
