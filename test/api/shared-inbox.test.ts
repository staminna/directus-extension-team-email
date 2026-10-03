import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharedInboxAccess, isSharedInboxRow, SHARED_INBOX_FILTER } from '../../src/api/shared-inbox';
import { makeDatabase } from './helpers';

const ROLE_UUID = '11111111-2222-3333-4444-555555555555';

describe('isSharedInboxRow', () => {
    it('is true only for unowned postmark rows', () => {
        expect(isSharedInboxRow(null)).toBe(false);
        expect(isSharedInboxRow(undefined)).toBe(false);
        expect(isSharedInboxRow({ owner: null, source: 'postmark' })).toBe(true);
        expect(isSharedInboxRow({ source: 'postmark' })).toBe(true);
        expect(isSharedInboxRow({ owner: 'u1', source: 'postmark' })).toBe(false);
        expect(isSharedInboxRow({ owner: { id: 'u1' }, source: 'postmark' })).toBe(false);
        expect(isSharedInboxRow({ owner: null, source: 'imap' })).toBe(false);
    });

    it('exposes the matching filter', () => {
        expect(SHARED_INBOX_FILTER).toEqual({ _and: [{ owner: { _null: true } }, { source: { _eq: 'postmark' } }] });
    });
});

describe('createSharedInboxAccess', () => {
    afterEach(() => vi.useRealTimers());

    const logger = { error: vi.fn() };

    it('denies anonymous callers and admits admins without a lookup', async () => {
        const { database } = makeDatabase();
        const access = createSharedInboxAccess({ database, env: {}, logger });
        expect(await access.canAccess(null)).toBe(false);
        expect(await access.canAccess({ user: null })).toBe(false);
        expect(await access.canAccess({ user: 'u', admin: true })).toBe(true);
        expect(database).not.toHaveBeenCalled();
    });

    it('uses default role names and matches role or parent roles', async () => {
        const { database, state } = makeDatabase();
        state.rows = [{ id: 'role-a' }];
        const access = createSharedInboxAccess({ database, env: {}, logger });
        expect(await access.canAccess({ user: 'u', role: 'role-a' })).toBe(true);
        expect(await access.canAccess({ user: 'u', role: 'x', roles: ['role-a'] })).toBe(true);
        expect(await access.canAccess({ user: 'u', role: null })).toBe(false);
        // Cached: one query for three checks.
        expect(database).toHaveBeenCalledTimes(1);
        const chain = state.calls[0].chain;
        // No ids configured -> placeholder uuid; names go through orWhereIn.
        expect(chain).toContainEqual(['whereIn', ['id', ['00000000-0000-0000-0000-000000000000']]]);
        expect(chain).toContainEqual(['orWhereIn', ['name', ['Administrativo', 'Administrator']]]);
    });

    it('splits ids from names (array env) and skips orWhereIn with ids only', async () => {
        const { database, state } = makeDatabase();
        state.rows = [{ id: ROLE_UUID }];
        const access = createSharedInboxAccess({ database, env: { EMAIL_SHARED_INBOX_ROLES: [ROLE_UUID, ' '] }, logger });
        expect(await access.canAccess({ user: 'u', role: ROLE_UUID })).toBe(true);
        const chain = state.calls[0].chain;
        expect(chain).toContainEqual(['whereIn', ['id', [ROLE_UUID]]]);
        expect(chain.some(([m]) => m === 'orWhereIn')).toBe(false);
    });

    it('re-queries after the cache expires', async () => {
        vi.useFakeTimers();
        const { database, state } = makeDatabase();
        state.rows = [];
        const access = createSharedInboxAccess({ database, env: { EMAIL_SHARED_INBOX_ROLES: 'Ops' }, logger });
        expect(await access.canAccess({ user: 'u', role: 'r' })).toBe(false);
        vi.advanceTimersByTime(61_000);
        state.rows = [{ id: 'r' }];
        expect(await access.canAccess({ user: 'u', role: 'r' })).toBe(true);
        expect(database).toHaveBeenCalledTimes(2);
    });

    it('fails closed and logs when the lookup throws', async () => {
        const { database, state } = makeDatabase();
        state.error = new Error('db down');
        const log = { error: vi.fn() };
        const access = createSharedInboxAccess({ database, env: { EMAIL_SHARED_INBOX_ROLES: null as any }, logger: log });
        expect(await access.canAccess({ user: 'u', role: 'r' })).toBe(false);
        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: state.error }), expect.stringContaining('could not resolve'));
    });
});
