import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = JSON.parse(readFileSync(new URL('../../schema/schema.json', import.meta.url), 'utf8'));
const collections: string[] = snapshot.collections.map((c: any) => c.collection);

type Handler = (method: string, path: string, body: any) => { status: number; body?: any; raw?: string };

let calls: Array<{ method: string; path: string; body: any; headers: any }>;
let logs: string[];
let errors: string[];
const origArgv = process.argv;

function stubFetch(handler: Handler) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        const path = url.replace('https://cms.test', '');
        const body = init.body === undefined ? undefined : JSON.parse(init.body);
        calls.push({ method: init.method, path, body, headers: init.headers });
        const r = handler(init.method, path, body);
        const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify({ data: r.body }));
        return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text };
    }));
}

async function run(args: string[] = [], env: Record<string, string | undefined> = { DIRECTUS_URL: 'https://cms.test//', DIRECTUS_TOKEN: 'tok' }) {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) vi.stubEnv(k, undefined as any);
        else vi.stubEnv(k, v);
    }
    process.argv = ['node', 'install-schema.mjs', ...args];
    vi.resetModules();
    await import('../../scripts/install-schema.mjs');
}

beforeEach(() => {
    calls = [];
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
    vi.spyOn(console, 'error').mockImplementation((m: string) => { errors.push(m); });
});

afterEach(() => {
    process.argv = origArgv;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('scripts/install-schema.mjs', () => {
    it('exits when URL or token are missing', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as any);
        await expect(run([], { DIRECTUS_URL: undefined, DIRECTUS_TOKEN: undefined })).rejects.toThrow('exit 1');
        expect(errors[0]).toMatch(/DIRECTUS_URL and DIRECTUS_TOKEN/);
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('creates every collection and relation on an empty project', async () => {
        stubFetch((method, path) => {
            if (method === 'GET' && path === '/collections') return { status: 200, body: [{ collection: 'directus_users' }] };
            if (method === 'GET' && path.startsWith('/relations/')) return { status: 404 };
            return { status: 200, raw: '' };
        });
        await run();
        expect(calls[0]).toMatchObject({ method: 'GET', path: '/collections' });
        expect(calls[0].headers.authorization).toBe('Bearer tok');
        const posts = calls.filter(c => c.method === 'POST' && c.path === '/collections');
        expect(posts.map(p => p.body.collection)).toEqual(collections);
        for (const p of posts) {
            for (const f of p.body.fields) {
                expect(f.meta?.collection).toBeUndefined();
                expect(f.schema?.foreign_key_table).toBeUndefined();
            }
        }
        const rels = calls.filter(c => c.method === 'POST' && c.path === '/relations');
        expect(rels).toHaveLength(snapshot.relations.length);
        expect(logs.at(-2)).toBe(`Created ${collections.length + snapshot.relations.length} item(s).`);
        expect(logs.at(-1)).toMatch(/Permissions/);
    });

    it('adds only missing fields and relations to an existing project', async () => {
        const [first, ...rest] = collections;
        const firstFields = snapshot.fields.filter((f: any) => f.collection === first).map((f: any) => f.field);
        const [rel0, ...otherRels] = snapshot.relations;
        stubFetch((method, path) => {
            if (method === 'GET' && path === '/collections') return { status: 200, body: collections.map(collection => ({ collection })) };
            if (method === 'GET' && path === `/fields/${first}`) return { status: 200, body: firstFields.slice(1).map((field: string) => ({ field })) };
            if (method === 'GET' && path.startsWith('/fields/')) return { status: 403 };
            if (method === 'GET' && path === `/relations/${rel0.collection}/${rel0.field}`) return { status: 200, body: { ok: 1 } };
            if (method === 'GET' && path.startsWith('/relations/')) return { status: 404 };
            return { status: 200, body: { id: 1 } };
        });
        await run();
        expect(calls.filter(c => c.method === 'POST' && c.path === '/collections')).toHaveLength(0);
        const fieldPosts = calls.filter(c => c.method === 'POST' && c.path.startsWith('/fields/'));
        expect(fieldPosts.find(c => c.path === `/fields/${first}`)?.body.field).toBe(firstFields[0]);
        const expectedFieldPosts = 1 + rest.reduce((n, c) => n + snapshot.fields.filter((f: any) => f.collection === c).length, 0);
        expect(fieldPosts).toHaveLength(expectedFieldPosts);
        expect(calls.filter(c => c.method === 'POST' && c.path === '/relations')).toHaveLength(otherRels.length);
    });

    it('dry run makes no writes', async () => {
        stubFetch((method, path) => {
            if (path === '/collections') return { status: 200, body: [] };
            return { status: 200, body: [] };
        });
        await run(['--dry-run']);
        expect(calls.every(c => c.method === 'GET')).toBe(true);
        expect(logs.some(l => l.startsWith('[dry-run] create collection'))).toBe(true);
        expect(logs.some(l => l.startsWith('Would create'))).toBe(true);
    });

    it('dry run against an up-to-date project reports nothing to do', async () => {
        stubFetch((method, path) => {
            if (path === '/collections') return { status: 200, body: collections.map(collection => ({ collection })) };
            const col = path.replace('/fields/', '');
            return { status: 200, body: snapshot.fields.filter((f: any) => f.collection === col).map((f: any) => ({ field: f.field })) };
        });
        await run(['--dry-run']);
        expect(logs).toContain('Schema already up to date.');
    });

    it('fails loudly on API errors', async () => {
        stubFetch(() => ({ status: 500, raw: 'kaboom' }));
        await expect(run()).rejects.toThrow('GET /collections → 500 kaboom');
    });

    it('treats a forbidden collections list as empty', async () => {
        stubFetch((method, path) => {
            if (path === '/collections' && method === 'GET') return { status: 403 };
            if (path.startsWith('/relations/')) return { status: 404 };
            return { status: 204 };
        });
        await run();
        expect(calls.filter(c => c.method === 'POST' && c.path === '/collections')).toHaveLength(collections.length);
    });

    it('handles minimal snapshot entries (no meta/schema, polymorphic relation)', async () => {
        const synthetic = {
            collections: [{ collection: 'c_new', meta: null }, { collection: 'c_old', meta: null }],
            fields: [
                { collection: 'c_new', field: 'id', type: 'integer', meta: null, schema: null },
                { collection: 'c_old', field: 'x', type: 'string', meta: null, schema: null },
            ],
            relations: [
                { collection: 'c_new', field: 'id', related_collection: null, meta: null, schema: null },
                { collection: 'c_old', field: 'x', related_collection: 'c_new', meta: { one_field: null }, schema: { on_delete: 'SET NULL', on_update: 'NO ACTION', extra: 1 } },
            ],
        };
        vi.doMock('node:fs', () => ({ readFileSync: () => JSON.stringify(synthetic) }));
        try {
            stubFetch((method, path) => {
                if (path === '/collections' && method === 'GET') return { status: 200, body: [{ collection: 'c_old' }] };
                if (path === '/fields/c_old') return { status: 404 };
                if (path.startsWith('/relations/')) return { status: 404 };
                return { status: 200, raw: '' };
            });
            await run();
            const col = calls.find(c => c.method === 'POST' && c.path === '/collections')!.body;
            expect(col).toEqual({ collection: 'c_new', meta: null, schema: {}, fields: [{ field: 'id', type: 'integer', meta: null, schema: null }] });
            expect(calls.find(c => c.path === '/fields/c_old' && c.method === 'POST')!.body).toEqual({ field: 'x', type: 'string', meta: null, schema: null });
            const rels = calls.filter(c => c.method === 'POST' && c.path === '/relations').map(c => c.body);
            expect(rels[0]).toEqual({ collection: 'c_new', field: 'id', related_collection: null, meta: null });
            expect(rels[1].schema).toEqual({ on_delete: 'SET NULL', on_update: 'NO ACTION' });
            expect(logs).toContain('create relation c_new.id → (any)');

            calls = [];
            logs = [];
            await run(['--dry-run']);
            expect(logs).toContain('[dry-run] create relation c_new.id → (any)');
            expect(logs.some(l => l.includes('c_old.x →'))).toBe(false);
        } finally {
            vi.doUnmock('node:fs');
        }
    });
});
