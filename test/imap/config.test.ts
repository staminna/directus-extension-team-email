import { describe, expect, it } from 'vitest';
import { readImapConfig } from '../../src/api/imap/config';

describe('readImapConfig', () => {
    it('applies defaults for an empty env', () => {
        const c = readImapConfig({});
        expect(c).toEqual({
            secret: undefined,
            defaultHost: '',
            defaultPort: 993,
            defaultSecure: true,
            allowedDomains: [],
            tlsRejectUnauthorized: true,
            syncEnabled: true,
            syncCron: '*/2 * * * *',
            minIntervalSeconds: 20,
            maxPerSync: 100,
            initialDays: 30,
            maxMessageBytes: 15 * 1024 * 1024,
            syncTimeoutMs: 120_000,
            attachmentsFolder: null,
            maxAttachmentBytes: 26_214_400,
            storageLocation: 'local',
        });
    });

    it('parses explicit values', () => {
        const c = readImapConfig({
            EMAIL_IMAP_SECRET: 12345,
            EMAIL_IMAP_DEFAULT_HOST: '  imap.example.com ',
            EMAIL_IMAP_DEFAULT_PORT: '143.9',
            EMAIL_IMAP_DEFAULT_SECURE: 'off',
            EMAIL_IMAP_ALLOWED_DOMAINS: 'A.com, b.com ,,',
            EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED: false,
            EMAIL_IMAP_SYNC_ENABLED: 'YES',
            EMAIL_IMAP_SYNC_CRON: '   ',
            EMAIL_IMAP_MIN_INTERVAL_SECONDS: '-5',
            EMAIL_IMAP_MAX_PER_SYNC: 'abc',
            EMAIL_ATTACHMENTS_FOLDER: 'folder-id',
            STORAGE_LOCATIONS: ['S3', 'local'],
        });
        expect(c.secret).toBe('12345');
        expect(c.defaultHost).toBe('imap.example.com');
        expect(c.defaultPort).toBe(143);
        expect(c.defaultSecure).toBe(false);
        expect(c.allowedDomains).toEqual(['a.com', 'b.com']);
        expect(c.tlsRejectUnauthorized).toBe(false);
        expect(c.syncEnabled).toBe(true);
        expect(c.syncCron).toBe('*/2 * * * *');
        expect(c.minIntervalSeconds).toBe(20);
        expect(c.maxPerSync).toBe(100);
        expect(c.attachmentsFolder).toBe('folder-id');
        expect(c.storageLocation).toBe('s3');
    });

    it('falls back on unrecognised booleans and keeps custom cron', () => {
        const c = readImapConfig({ EMAIL_IMAP_DEFAULT_SECURE: 'maybe', EMAIL_IMAP_SYNC_ENABLED: '0', EMAIL_IMAP_SYNC_CRON: '*/5 * * * *', STORAGE_LOCATIONS: 'gcs,local' });
        expect(c.defaultSecure).toBe(true);
        expect(c.syncEnabled).toBe(false);
        expect(c.syncCron).toBe('*/5 * * * *');
        expect(c.storageLocation).toBe('gcs');
    });
});
