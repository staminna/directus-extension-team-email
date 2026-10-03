import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    running: new Set<string>(),
    syncAccount: vi.fn(),
    listActive: vi.fn(),
}));
vi.mock('../../src/api/imap/sync', () => ({
    isRunning: (id: string) => m.running.has(id),
    syncAccount: m.syncAccount,
}));
vi.mock('../../src/api/imap/accounts', () => ({ listActive: m.listActive }));

import hook from '../../src/hooks/imap-sync';

const SECRET = 'h'.repeat(32);

function setup(env: Record<string, unknown>) {
    const schedule = vi.fn();
    const init = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (hook as any)({ schedule, init }, {
        services: { ItemsService: 'IS', FilesService: 'FS' }, getSchema: async () => 'schema', env, logger, database: 'db',
    });
    init.mock.calls[0][1]();
    return { schedule, logger, tick: schedule.mock.calls[0]?.[1] as (() => Promise<void>) | undefined };
}

beforeEach(() => {
    m.running.clear();
    m.syncAccount.mockReset().mockResolvedValue({ status: 'ok' });
    m.listActive.mockReset().mockResolvedValue([]);
});

describe('imap-sync hook', () => {
    it('logs that the secret is missing; tick is a no-op', async () => {
        const s = setup({});
        expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining('EMAIL_IMAP_SECRET not set'));
        await s.tick!();
        expect(m.listActive).not.toHaveBeenCalled();
    });

    it('does not schedule when disabled', () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET, EMAIL_IMAP_SYNC_ENABLED: 'false' });
        expect(s.logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
        expect(s.schedule).not.toHaveBeenCalled();
    });

    it('syncs every idle active account, isolating failures', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET, EMAIL_IMAP_SYNC_CRON: '*/5 * * * *' });
        expect(s.schedule.mock.calls[0][0]).toBe('*/5 * * * *');
        expect(s.logger.info).toHaveBeenCalledWith(expect.stringContaining('scheduled (*/5 * * * *)'));
        m.listActive.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        m.running.add('b');
        m.syncAccount.mockRejectedValueOnce(new Error('a failed'));
        await s.tick!();
        expect(m.listActive).toHaveBeenCalledWith({ ItemsService: 'IS', FilesService: 'FS', schema: 'schema', database: 'db', logger: s.logger });
        expect(m.syncAccount.mock.calls.map(c => c[2].id)).toEqual(['a', 'c']);
        expect(s.logger.error).toHaveBeenCalledWith(expect.objectContaining({ account: 'a' }), expect.any(String));
    });

    it('skips overlapping ticks and recovers after a failed tick', async () => {
        const s = setup({ EMAIL_IMAP_SECRET: SECRET });
        let release!: () => void;
        m.listActive.mockReturnValueOnce(new Promise(r => { release = () => r([]); }));
        const first = s.tick!();
        await s.tick!();
        expect(s.logger.debug).toHaveBeenCalledWith(expect.stringContaining('still running'));
        release();
        await first;
        m.listActive.mockRejectedValueOnce(new Error('db'));
        await s.tick!();
        expect(s.logger.error).toHaveBeenCalledWith(expect.anything(), 'email-imap: cron tick failed');
        await s.tick!();
        expect(m.listActive).toHaveBeenCalledTimes(3);
    });
});
