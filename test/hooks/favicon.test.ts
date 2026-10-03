import { afterEach, describe, expect, it, vi } from 'vitest';
import hook from '../../src/hooks/favicon';

function setup(rowOrErr: any) {
    const init = vi.fn();
    const logger = { warn: vi.fn() };
    const first = vi.fn(async () => {
        if (rowOrErr instanceof Error) throw rowOrErr;
        return rowOrErr;
    });
    const database = vi.fn(() => ({ select: () => ({ first }) }));
    (hook as any)({ init }, { database, logger });
    expect(init).toHaveBeenCalledWith('routes.before', expect.any(Function));
    const app = { get: vi.fn() };
    init.mock.calls[0][1]({ app });
    expect(app.get.mock.calls[0][0]).toBe('/favicon.ico');
    const handler = app.get.mock.calls[0][1];
    const hit = async () => {
        const res = { setHeader: vi.fn(), redirect: vi.fn() };
        await handler({}, res);
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=86400');
        return res.redirect.mock.calls[0];
    };
    return { hit, first, logger };
}

afterEach(() => vi.useRealTimers());

describe('favicon hook', () => {
    it('redirects to the project favicon and caches it for 5 minutes', async () => {
        vi.useFakeTimers();
        const s = setup({ public_favicon: 'a b' });
        expect(await s.hit()).toEqual([302, '/assets/a%20b']);
        expect(await s.hit()).toEqual([302, '/assets/a%20b']);
        expect(s.first).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5 * 60_000 + 1);
        await s.hit();
        expect(s.first).toHaveBeenCalledTimes(2);
    });

    it('falls back to the admin favicon when unset or on error', async () => {
        expect(await setup(undefined).hit()).toEqual([302, '/admin/favicon.ico']);
        const s = setup(new Error('db'));
        expect(await s.hit()).toEqual([302, '/admin/favicon.ico']);
        expect(s.logger.warn).toHaveBeenCalled();
    });
});
