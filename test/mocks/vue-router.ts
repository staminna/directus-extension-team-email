/**
 * vue-router is provided by the Directus app at runtime and is not installed
 * here. Tests set `route` / `router` state and inspect calls.
 */
import { vi } from 'vitest';
import { reactive } from 'vue';

export const route = reactive<{ params: Record<string, any>; query: Record<string, any>; path: string }>({
    params: {},
    query: {},
    path: '/',
});
export const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
export const leaveGuards: Array<(...a: any[]) => any> = [];

export const useRoute = () => route;
export const useRouter = () => router;
export const onBeforeRouteLeave = (fn: (...a: any[]) => any) => {
    leaveGuards.push(fn);
};

export function resetRouter(): void {
    route.params = {};
    route.query = {};
    route.path = '/';
    router.push.mockReset();
    router.replace.mockReset();
    router.back.mockReset();
    leaveGuards.length = 0;
}
