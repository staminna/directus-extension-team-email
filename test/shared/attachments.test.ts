import { describe, expect, it, vi } from 'vitest';
import {
    attachmentUrl, extensionOf, formatBytes, iconFor, kindFor, loadAttachments, previewable,
} from '../../src/shared/attachments';

describe('shared/attachments', () => {
    it('kindFor', () => {
        expect(kindFor('emails')).toBe('sent');
        expect(kindFor('inbox_email')).toBe('received');
        expect(kindFor(null)).toBe('received');
    });

    it('attachmentUrl honours baseURL and inline', () => {
        expect(attachmentUrl({ defaults: { baseURL: '/dx/' } }, 5, 'f/1', 'sent')).toBe('/dx/email/message/5/attachment/f%2F1?kind=sent');
        expect(attachmentUrl(null, 'a b', 'f', 'received', true)).toBe('/email/message/a%20b/attachment/f?kind=received&inline=1');
    });

    it('loadAttachments ok / non-array', async () => {
        const api = { get: vi.fn().mockResolvedValue({ data: { data: [{ id: '1' }] } }) };
        expect(await loadAttachments(api, 7, 'sent')).toEqual({ state: 'ok', files: [{ id: '1' }] });
        expect(api.get).toHaveBeenCalledWith('/email/message/7/attachments', { params: { kind: 'sent' } });
        api.get.mockResolvedValue({ data: null });
        expect(await loadAttachments(api, 7, 'sent')).toEqual({ state: 'ok', files: [] });
    });

    it('loadAttachments errors', async () => {
        const api = { get: vi.fn() };
        api.get.mockRejectedValueOnce({ response: { status: 403 } });
        expect(await loadAttachments(api, 1, 'x')).toEqual({ state: 'forbidden' });
        api.get.mockRejectedValueOnce({ response: { status: 404 } });
        expect(await loadAttachments(api, 1, 'x')).toEqual({ state: 'ok', files: [] });
        api.get.mockRejectedValueOnce(new Error('boom'));
        expect(await loadAttachments(api, 1, 'x')).toEqual({ state: 'error', message: 'boom' });
        api.get.mockRejectedValueOnce(undefined);
        expect(await loadAttachments(api, 1, 'x')).toEqual({ state: 'error', message: 'Não foi possível carregar os anexos.' });
    });

    it('previewable', () => {
        expect(previewable('IMAGE/PNG')).toBe(true);
        expect(previewable('text/html')).toBe(false);
        expect(previewable(null)).toBe(false);
    });

    it('formatBytes', () => {
        expect(formatBytes(null)).toBe('');
        expect(formatBytes(NaN)).toBe('');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(20 * 1024)).toBe('20 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
        expect(formatBytes(3 * 1024 ** 4)).toBe('3072 GB');
    });

    it('iconFor', () => {
        expect(iconFor('image/png')).toBe('image');
        expect(iconFor('audio/mp3')).toBe('audio_file');
        expect(iconFor('video/mp4')).toBe('video_file');
        expect(iconFor('application/pdf')).toBe('picture_as_pdf');
        expect(iconFor('application/zip')).toBe('folder_zip');
        expect(iconFor('application/x-tar')).toBe('folder_zip');
        expect(iconFor('application/vnd.ms-excel')).toBe('table_chart');
        expect(iconFor('text/csv')).toBe('table_chart');
        expect(iconFor('application/msword')).toBe('description');
        expect(iconFor('text/plain')).toBe('description');
        expect(iconFor(undefined)).toBe('draft');
    });

    it('extensionOf', () => {
        expect(extensionOf('report.pdf')).toBe('PDF');
        expect(extensionOf('noext')).toBe('');
        expect(extensionOf(undefined as any)).toBe('');
    });
});
