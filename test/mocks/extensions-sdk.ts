/**
 * Test stand-in for @directus/extensions-sdk. The define* helpers are
 * identity functions (as in the real SDK); useApi returns a shared vi.fn()
 * based client that each test configures.
 */
import { vi } from 'vitest';

export const defineEndpoint = <T>(c: T): T => c;
export const defineHook = <T>(c: T): T => c;
export const defineModule = <T>(c: T): T => c;
export const defineInterface = <T>(c: T): T => c;
export const defineDisplay = <T>(c: T): T => c;

export const api = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: '' },
};

export const useApi = () => api;

export function resetApi(): void {
    for (const k of ['get', 'post', 'patch', 'delete'] as const) api[k].mockReset();
}
