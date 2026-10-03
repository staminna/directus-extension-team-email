/**
 * Harness for the /email endpoint: a router that records handlers, fake
 * Directus services keyed by collection, and a chainable knex stand-in.
 */
import { vi } from 'vitest';

export type Handler = (req: any, res: any) => any;

export function makeRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as any,
        headers: {} as Record<string, string>,
        destroyed: false,
    };
    res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
    res.json = vi.fn((b: any) => { res.body = b; return res; });
    res.send = vi.fn((b: any) => { res.body = b; return res; });
    res.setHeader = vi.fn((k: string, v: string) => { res.headers[k] = v; });
    res.destroy = vi.fn(() => { res.destroyed = true; });
    return res;
}

export function makeCollectionMock() {
    return {
        readByQuery: vi.fn(async (_q?: any): Promise<any[]> => []),
        readOne: vi.fn(async (_id?: any, _q?: any): Promise<any> => null),
        readMany: vi.fn(async (_ids?: any, _q?: any): Promise<any[]> => []),
        createOne: vi.fn(async (_data?: any): Promise<any> => 'new-id'),
        updateOne: vi.fn(async (_id?: any, _data?: any): Promise<any> => undefined),
        deleteOne: vi.fn(async (_id?: any): Promise<any> => undefined),
    };
}
export type CollectionMock = ReturnType<typeof makeCollectionMock>;

/** Chainable query builder that resolves to `rows` (or rejects with `error`). */
export function makeDatabase() {
    const state = { rows: [] as any[], error: null as any, calls: [] as Array<{ table: string; chain: Array<[string, any[]]> }> };
    const database: any = vi.fn((table: string) => {
        const call = { table, chain: [] as Array<[string, any[]]> };
        state.calls.push(call);
        const builder: any = {};
        for (const m of ['select', 'where', 'whereIn', 'orWhereIn', 'andWhere']) {
            builder[m] = (...args: any[]) => {
                call.chain.push([m, args]);
                // Execute nested `where(q => ...)` callbacks against the same builder.
                if (m === 'where' && typeof args[0] === 'function') args[0](builder);
                return builder;
            };
        }
        builder.then = (resolve: any, reject: any) =>
            (state.error ? Promise.reject(state.error) : Promise.resolve(state.rows)).then(resolve, reject);
        return builder;
    });
    database.raw = vi.fn((sql: string, bindings: any[]) => ({ sql, bindings }));
    return { database, state };
}

export function setupEndpoint(endpoint: any, env: Record<string, unknown> = {}) {
    const routes = new Map<string, Handler>();
    const router: any = {};
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        router[m] = vi.fn((path: string, h: Handler) => { routes.set(`${m.toUpperCase()} ${path}`, h); });
    }

    const collections = new Map<string, CollectionMock>();
    const col = (name: string): CollectionMock => {
        if (!collections.has(name)) collections.set(name, makeCollectionMock());
        return collections.get(name)!;
    };
    const ctorCalls: Array<{ collection: string; opts: any }> = [];

    class ItemsService {
        constructor(collection: string, opts: any) {
            ctorCalls.push({ collection, opts });
            return col(collection) as any;
        }
    }

    const files = { uploadOne: vi.fn(async (): Promise<any> => 'file-1'), readMany: vi.fn(async (): Promise<any[]> => []) };
    const filesCtor: any[] = [];
    class FilesService { constructor(opts: any) { filesCtor.push(opts); return files as any; } }

    const mail = { send: vi.fn(async (_o?: any): Promise<any> => ({ messageId: '<smtp-id@x>' })) };
    class MailService { constructor(_opts: any) { return mail as any; } }

    const assets = { getAsset: vi.fn(async (..._a: any[]): Promise<any> => ({})) };
    const assetsCtor: any[] = [];
    class AssetsService { constructor(opts: any) { assetsCtor.push(opts); return assets as any; } }

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { database, state: dbState } = makeDatabase();
    const schema = { collections: {} };
    const getSchema = vi.fn(async () => schema);

    const ctx = {
        services: { ItemsService, FilesService, MailService, AssetsService },
        getSchema,
        env,
        logger,
        database,
    };
    endpoint.handler(router, ctx);

    async function call(method: string, path: string, req: any = {}) {
        const h = routes.get(`${method} ${path}`);
        if (!h) throw new Error(`no route ${method} ${path}`);
        const res = makeRes();
        const fullReq = { params: {}, query: {}, headers: {}, ...req };
        const ret = await h(fullReq, res);
        return { res, ret };
    }

    return { routes, router, ctx, col, ctorCalls, files, filesCtor, mail, assets, assetsCtor, logger, database, dbState, schema, call };
}

export const USER = { user: 'u1', role: 'r1', admin: false };
