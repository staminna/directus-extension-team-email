/**
 * Team Email — IMAP credential encryption
 * ------------------------------------------------------------------
 * Mailbox passwords are stored encrypted at rest with AES-256-GCM. The key is
 * derived from EMAIL_IMAP_SECRET with HKDF, so the secret itself is never used
 * as the key and rotating it invalidates every stored password at once (users
 * simply re-enter theirs).
 *
 * The owner id is bound in as additional authenticated data: a ciphertext
 * copied from one user's row onto another's fails to decrypt.
 *
 * Wire format (one line, safe for a text column):
 *   v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = 'directus-team-email/imap-password/v1';
const HKDF_SALT = 'directus-team-email';

export class ImapSecretMissing extends Error {
    constructor() {
        super('EMAIL_IMAP_SECRET is not set; refusing to store or read mailbox passwords');
        this.name = 'ImapSecretMissing';
    }
}

function deriveKey(secret: string | undefined): Buffer {
    const s = (secret ?? '').trim();
    if (s.length < 16) throw new ImapSecretMissing();
    return Buffer.from(hkdfSync('sha256', s, HKDF_SALT, HKDF_INFO, 32));
}

export function encryptPassword(secret: string | undefined, plaintext: string, ownerId: string): string {
    const key = deriveKey(secret);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(ownerId, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptPassword(secret: string | undefined, blob: string, ownerId: string): string {
    const key = deriveKey(secret);
    const parts = (blob ?? '').split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('stored mailbox password has an unknown format');
    }
    const [, ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64!, 'base64url');
    const tag = Buffer.from(tagB64!, 'base64url');
    const ct = Buffer.from(ctB64!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('stored mailbox password is corrupt');
    }
    const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(ownerId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when a secret is configured and long enough to be used. */
export function secretUsable(secret: string | undefined): boolean {
    return (secret ?? '').trim().length >= 16;
}
