/**
 * Team Email — IMAP account storage
 * ------------------------------------------------------------------
 * One row per Directus user in `email_imap_accounts`. All reads and writes
 * go through system-level services and are scoped by owner here, in code;
 * the role policy grants users nothing on this collection, so the only way to
 * reach a row is through the /email/imap/* routes as the authenticated owner.
 *
 * The password never leaves this module in the clear: `toPublic()` strips it,
 * and `decryptFor()` is the single place it is decrypted, right before an IMAP
 * connection is opened.
 */

import { decryptPassword, encryptPassword } from './crypto';
import type { ImapConfig } from './config';

export const ACCOUNTS_COLLECTION = 'email_imap_accounts';

export interface ImapAccountRow {
    id: string;
    owner: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password_enc: string;
    mailbox: string;
    is_active: boolean;
    initial_days: number | null;
    uid_validity: string | number | null; // bigint comes back as string from pg
    last_uid: string | number | null;
    last_sync_at: string | null;
    last_sync_status: 'ok' | 'error' | 'running' | 'never' | null;
    last_error: string | null;
    date_created?: string;
    date_updated?: string | null;
}

/** What the settings screen is allowed to see. Never includes the password. */
export interface ImapAccountPublic {
    id: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    mailbox: string;
    is_active: boolean;
    initial_days: number | null;
    has_password: boolean;
    last_uid: number;
    last_sync_at: string | null;
    last_sync_status: string;
    last_error: string | null;
}

export const ACCOUNT_FIELDS: Array<keyof ImapAccountRow> = [
    'id', 'owner', 'host', 'port', 'secure', 'username', 'password_enc', 'mailbox',
    'is_active', 'initial_days', 'uid_validity', 'last_uid', 'last_sync_at',
    'last_sync_status', 'last_error', 'date_created', 'date_updated',
];

export function toPublic(row: ImapAccountRow): ImapAccountPublic {
    return {
        id: row.id,
        host: row.host,
        port: Number(row.port),
        secure: !!row.secure,
        username: row.username,
        mailbox: row.mailbox || 'INBOX',
        is_active: !!row.is_active,
        initial_days: row.initial_days == null ? null : Number(row.initial_days),
        has_password: !!row.password_enc,
        last_uid: Number(row.last_uid ?? 0),
        last_sync_at: row.last_sync_at,
        last_sync_status: row.last_sync_status ?? 'never',
        last_error: row.last_error,
    };
}

export interface AccountsDeps {
    ItemsService: any;
    schema: any;
    database: any;
}

export function accountsService({ ItemsService, schema, database }: AccountsDeps) {
    return new ItemsService(ACCOUNTS_COLLECTION, { schema, knex: database });
}

export async function findByOwner(deps: AccountsDeps, ownerId: string): Promise<ImapAccountRow | null> {
    const svc = accountsService(deps);
    const rows = await svc.readByQuery({
        filter: { owner: { _eq: ownerId } },
        fields: ACCOUNT_FIELDS,
        limit: 1,
    });
    return (rows[0] as ImapAccountRow) ?? null;
}

export async function listActive(deps: AccountsDeps): Promise<ImapAccountRow[]> {
    const svc = accountsService(deps);
    return (await svc.readByQuery({
        filter: { is_active: { _eq: true } },
        fields: ACCOUNT_FIELDS,
        sort: ['last_sync_at'],
        limit: -1,
    })) as ImapAccountRow[];
}

export interface UpsertInput {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    /** Plain text, only when the user (re)entered it. */
    password?: string;
    mailbox?: string;
    initial_days?: number | null;
    is_active?: boolean;
}

/**
 * Create or update the caller's row. A changed host/username/mailbox resets
 * the cursor (uid_validity/last_uid) because UIDs are only meaningful within
 * one mailbox on one server.
 */
export async function upsertForOwner(
    deps: AccountsDeps,
    cfg: ImapConfig,
    ownerId: string,
    input: UpsertInput,
    existing: ImapAccountRow | null,
): Promise<ImapAccountRow> {
    const svc = accountsService(deps);

    const patch: Partial<ImapAccountRow> = {
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username,
        mailbox: input.mailbox || 'INBOX',
        is_active: input.is_active ?? true,
    };
    if (input.initial_days !== undefined) patch.initial_days = input.initial_days;
    if (input.password) patch.password_enc = encryptPassword(cfg.secret, input.password, ownerId);

    if (!existing) {
        if (!patch.password_enc) throw new Error('password is required for a new account');
        const id = await svc.createOne({
            ...patch,
            owner: ownerId,
            uid_validity: null,
            last_uid: 0,
            last_sync_status: 'never',
            last_error: null,
        });
        return (await svc.readOne(id, { fields: ACCOUNT_FIELDS })) as ImapAccountRow;
    }

    const cursorReset =
        existing.host !== patch.host ||
        existing.username !== patch.username ||
        (existing.mailbox || 'INBOX') !== patch.mailbox;
    if (cursorReset) {
        patch.uid_validity = null;
        patch.last_uid = 0;
        patch.last_sync_status = 'never';
        patch.last_error = null;
    }

    await svc.updateOne(existing.id, patch);
    return (await svc.readOne(existing.id, { fields: ACCOUNT_FIELDS })) as ImapAccountRow;
}

export async function deleteForOwner(deps: AccountsDeps, existing: ImapAccountRow): Promise<void> {
    const svc = accountsService(deps);
    await svc.deleteOne(existing.id);
}

export async function patchSyncState(
    deps: AccountsDeps,
    id: string,
    patch: Partial<Pick<ImapAccountRow, 'uid_validity' | 'last_uid' | 'last_sync_at' | 'last_sync_status' | 'last_error'>>,
): Promise<void> {
    const svc = accountsService(deps);
    await svc.updateOne(id, patch);
}

/** The one place a stored password is turned back into plain text. */
export function decryptFor(cfg: ImapConfig, row: ImapAccountRow): string {
    return decryptPassword(cfg.secret, row.password_enc, row.owner);
}

/** Enforce EMAIL_IMAP_ALLOWED_DOMAINS on a mailbox username. */
export function usernameAllowed(cfg: ImapConfig, username: string): boolean {
    if (cfg.allowedDomains.length === 0) return true;
    const at = username.lastIndexOf('@');
    if (at < 0) return false;
    const domain = username.slice(at + 1).toLowerCase();
    return cfg.allowedDomains.includes(domain);
}
