/** Controllable in-memory ImapFlow + postal-mime used via vi.mock. */
import { vi } from 'vitest';

export interface FakeMsg {
    uid: number;
    size?: number;
    flags?: any;
    internalDate?: any;
    envelope?: any;
    source?: Buffer | null;
}

export const imapState = {
    messages: [] as FakeMsg[],
    mailbox: { uidValidity: 1n as any, uidNext: null as any, exists: 0 } as any,
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(() => {}),
    release: vi.fn(),
    search: null as null | ((q: any) => any),
    clients: [] as any[],
};

export function resetImap() {
    imapState.messages = [];
    imapState.mailbox = { uidValidity: 1n, uidNext: null, exists: 0 };
    imapState.connect = vi.fn(async () => {});
    imapState.logout = vi.fn(async () => {});
    imapState.close = vi.fn(() => {});
    imapState.release = vi.fn();
    imapState.search = null;
    imapState.clients = [];
}

export class FakeImapFlow {
    opts: any;
    searches: any[] = [];
    constructor(opts: any) {
        this.opts = opts;
        imapState.clients.push(this);
    }
    get mailbox() {
        return imapState.mailbox;
    }
    connect() {
        return imapState.connect();
    }
    async getMailboxLock(path: string, opts: any) {
        (this as any).locked = { path, opts };
        return { release: imapState.release };
    }
    async search(q: any, _o: any) {
        this.searches.push(q);
        if (imapState.search) return imapState.search(q);
        if (q.since) return imapState.messages.map(m => m.uid);
        const from = Number(String(q.uid).split(':')[0]);
        return imapState.messages.filter(m => m.uid >= from).map(m => m.uid);
    }
    async fetchAll(uids: number[], query: any) {
        const set = new Set(uids);
        const picked = imapState.messages.filter(m => set.has(m.uid));
        if (query.source) return picked.map(m => ({ uid: m.uid, source: m.source }));
        return picked.map(m => ({ uid: m.uid, size: m.size, flags: m.flags, internalDate: m.internalDate, envelope: m.envelope })).reverse();
    }
    logout() {
        return imapState.logout();
    }
    close() {
        return imapState.close();
    }
}

export const postalParse = vi.fn();
