import { describe, expect, it } from 'vitest';
import { decryptPassword, encryptPassword, ImapSecretMissing, secretUsable } from '../../src/api/imap/crypto';

const SECRET = 'x'.repeat(32);

describe('imap crypto', () => {
    it('round-trips a password bound to the owner', () => {
        const blob = encryptPassword(SECRET, 'hunter2', 'user-1');
        expect(blob.startsWith('v1.')).toBe(true);
        expect(blob.split('.')).toHaveLength(4);
        expect(decryptPassword(SECRET, blob, 'user-1')).toBe('hunter2');
    });

    it('produces a different ciphertext each time', () => {
        expect(encryptPassword(SECRET, 'a', 'u')).not.toBe(encryptPassword(SECRET, 'a', 'u'));
    });

    it('refuses to decrypt for another owner or another secret', () => {
        const blob = encryptPassword(SECRET, 'pw', 'user-1');
        expect(() => decryptPassword(SECRET, blob, 'user-2')).toThrow();
        expect(() => decryptPassword('y'.repeat(32), blob, 'user-1')).toThrow();
    });

    it('throws ImapSecretMissing for short or missing secrets', () => {
        expect(() => encryptPassword(undefined, 'pw', 'u')).toThrow(ImapSecretMissing);
        expect(() => encryptPassword('   short   ', 'pw', 'u')).toThrow(/EMAIL_IMAP_SECRET/);
        try {
            decryptPassword('', 'v1.a.b.c', 'u');
        } catch (e: any) {
            expect(e.name).toBe('ImapSecretMissing');
        }
    });

    it('rejects unknown formats and corrupt blobs', () => {
        expect(() => decryptPassword(SECRET, 'v2.a.b.c', 'u')).toThrow(/unknown format/);
        expect(() => decryptPassword(SECRET, 'v1.a.b', 'u')).toThrow(/unknown format/);
        expect(() => decryptPassword(SECRET, undefined as any, 'u')).toThrow(/unknown format/);
        expect(() => decryptPassword(SECRET, 'v1.AAAA.AAAA.AAAA', 'u')).toThrow(/corrupt/);
    });

    it('secretUsable', () => {
        expect(secretUsable(undefined)).toBe(false);
        expect(secretUsable('  ' + 'a'.repeat(15) + '  ')).toBe(false);
        expect(secretUsable('a'.repeat(16))).toBe(true);
    });
});
