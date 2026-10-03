/**
 * App-side helpers for the email attachment interface and display.
 * The server decides access; these only build URLs and format rows.
 */

export type AttachmentRow = {
    id: string;
    filename: string;
    type: string;
    filesize: number | null;
};

export type AttachmentList =
    | { state: 'ok'; files: AttachmentRow[] }
    | { state: 'forbidden' }
    | { state: 'error'; message: string };

export function kindFor(collection: string | null | undefined): 'sent' | 'received' {
    return collection === 'emails' ? 'sent' : 'received';
}

function apiBase(api: any): string {
    // Not fixed at the site root: Directus may be mounted under a path.
    return String(api?.defaults?.baseURL || '/').replace(/\/$/, '');
}

export function attachmentUrl(api: any, messageId: string | number, fileId: string, kind: string, inline = false): string {
    const q = new URLSearchParams({ kind });
    if (inline) q.set('inline', '1');
    return `${apiBase(api)}/email/message/${encodeURIComponent(String(messageId))}/attachment/${encodeURIComponent(fileId)}?${q}`;
}

export async function loadAttachments(api: any, messageId: string | number, kind: string): Promise<AttachmentList> {
    try {
        const { data } = await api.get(`/email/message/${encodeURIComponent(String(messageId))}/attachments`, {
            params: { kind },
        });
        return { state: 'ok', files: Array.isArray(data?.data) ? data.data : [] };
    } catch (e: any) {
        if (e?.response?.status === 403) return { state: 'forbidden' };
        if (e?.response?.status === 404) return { state: 'ok', files: [] };
        return { state: 'error', message: e?.message || 'Não foi possível carregar os anexos.' };
    }
}

// Must match INLINE_SAFE_TYPES on the server.
const INLINE_SAFE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);

export function previewable(type: string | null | undefined): boolean {
    return INLINE_SAFE.has(String(type || '').toLowerCase());
}

export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function iconFor(type: string | null | undefined): string {
    const t = String(type || '').toLowerCase();
    if (t.startsWith('image/')) return 'image';
    if (t.startsWith('audio/')) return 'audio_file';
    if (t.startsWith('video/')) return 'video_file';
    if (t === 'application/pdf') return 'picture_as_pdf';
    if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return 'folder_zip';
    if (t.includes('sheet') || t.includes('excel') || t === 'text/csv') return 'table_chart';
    if (t.includes('word') || t.includes('document') || t.startsWith('text/')) return 'description';
    return 'draft';
}

export function extensionOf(filename: string): string {
    const m = /\.([a-z0-9]{1,6})$/i.exec(filename || '');
    return m ? m[1]!.toUpperCase() : '';
}
