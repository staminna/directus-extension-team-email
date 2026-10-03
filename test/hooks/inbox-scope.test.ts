import { describe, expect, it, vi } from 'vitest';
import hook from '../../src/hooks/inbox-scope';
import { SHARED_INBOX_FILTER } from '../../src/api/shared-inbox';

function register(env: Record<string, unknown> = {}) {
    const filter = vi.fn();
    const logger = { info: vi.fn() };
    (hook as any)({ filter }, { env, logger });
    return { filter, logger, fn: filter.mock.calls[0]?.[1] };
}

describe('inbox-scope hook', () => {
    it('is disabled with EMAIL_CONTENT_SHARED_ONLY=false', () => {
        const r = register({ EMAIL_CONTENT_SHARED_ONLY: ' FALSE ' });
        expect(r.filter).not.toHaveBeenCalled();
        expect(r.logger.info).toHaveBeenCalled();
    });

    it('scopes user browse queries to the shared mailbox', () => {
        const { filter, fn } = register();
        expect(filter.mock.calls[0][0]).toBe('inbox_email.items.query');
        const ctx = { accountability: { user: 'u' } };
        expect(fn({ limit: 5 }, {}, ctx)).toEqual({ limit: 5, filter: SHARED_INBOX_FILTER });
        const f = { subject: { _contains: 'x' } };
        expect(fn({ filter: f }, {}, ctx)).toEqual({ filter: { _and: [f, SHARED_INBOX_FILTER] } });
        expect(fn(undefined, {}, ctx)).toEqual({ filter: SHARED_INBOX_FILTER });
    });

    it('passes through system calls and targeted queries', () => {
        const { fn } = register();
        const q = { filter: { x: 1 } };
        expect(fn(q, {}, null)).toBe(q);
        expect(fn(q, {}, { accountability: {} })).toBe(q);
        const ctx = { accountability: { user: 'u' } };
        for (const filter of [
            { id: { _eq: 1 } },
            { _and: [{ subject: { _eq: 'a' } }, { owner: { _eq: 'u' } }] },
            { _or: [{ nested: { thread_id: { _eq: 't' } } }] },
        ]) {
            const tq = { filter };
            expect(fn(tq, {}, ctx)).toBe(tq);
        }
        const nonTargeted = { filter: { _and: [null, 'x', { subject: { _eq: 'a' } }] } };
        expect(fn(nonTargeted, {}, ctx).filter._and[1]).toBe(SHARED_INBOX_FILTER);
    });
});
