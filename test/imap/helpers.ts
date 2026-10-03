/** In-memory ItemsService stand-in shared by the IMAP / hook tests. */
import { vi } from 'vitest';

export type Store = Record<string, Map<string, any>>;

function matches(row: any, filter: any): boolean {
    if (!filter) return true;
    if (filter._and) return filter._and.every((f: any) => matches(row, f));
    return Object.entries(filter).every(([k, cond]: [string, any]) => {
        if (cond && typeof cond === 'object') {
            if ('_eq' in cond) return row[k] === cond._eq;
            if ('_in' in cond) return cond._in.includes(row[k]);
        }
        return true;
    });
}

export function makeItemsService(store: Store = {}) {
    let seq = 0;
    const calls: Array<{ collection: string; method: string; args: any[] }> = [];
    class ItemsService {
        collection: string;
        opts: any;
        constructor(collection: string, opts: any) {
            this.collection = collection;
            this.opts = opts;
            store[collection] ??= new Map();
        }
        get map() {
            return store[this.collection]!;
        }
        async readByQuery(q: any) {
            calls.push({ collection: this.collection, method: 'readByQuery', args: [q] });
            let rows = [...this.map.values()].filter(r => matches(r, q?.filter));
            if (q?.limit && q.limit > 0) rows = rows.slice(0, q.limit);
            return rows.map(r => ({ ...r }));
        }
        async readOne(id: string) {
            calls.push({ collection: this.collection, method: 'readOne', args: [id] });
            const r = this.map.get(String(id));
            if (!r) throw new Error('not found');
            return { ...r };
        }
        async createOne(data: any) {
            calls.push({ collection: this.collection, method: 'createOne', args: [data] });
            const id = data.id ?? `id-${++seq}`;
            this.map.set(String(id), { ...data, id });
            return id;
        }
        async updateOne(id: string, data: any) {
            calls.push({ collection: this.collection, method: 'updateOne', args: [id, data] });
            const r = this.map.get(String(id)) ?? { id };
            this.map.set(String(id), { ...r, ...data });
            return id;
        }
        async deleteOne(id: string) {
            calls.push({ collection: this.collection, method: 'deleteOne', args: [id] });
            this.map.delete(String(id));
            return id;
        }
    }
    return { ItemsService, store, calls };
}

export function logger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
