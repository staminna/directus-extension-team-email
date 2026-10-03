// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { useCurrentUser } from '../../src/module/composables/useCurrentUser';
import { api, resetApi } from '../mocks/extensions-sdk';

function harness() {
    let state: ReturnType<typeof useCurrentUser>;
    mount(defineComponent({ setup() { state = useCurrentUser(); return () => h('div'); } }));
    return () => state!;
}

describe('useCurrentUser', () => {
    beforeEach(resetApi);

    it('loads the current user id', async () => {
        api.get.mockResolvedValue({ data: { data: { id: 'u1' } } });
        const s = harness();
        expect(s().loading.value).toBe(true);
        await flushPromises();
        expect(api.get).toHaveBeenCalledWith('/users/me', { params: { fields: ['id'] } });
        expect(s().id.value).toBe('u1');
        expect(s().loading.value).toBe(false);
    });

    it('falls back to null when the payload has no id', async () => {
        api.get.mockResolvedValue({ data: {} });
        const s = harness();
        await flushPromises();
        expect(s().id.value).toBeNull();
    });

    it('records the error', async () => {
        const err = new Error('nope');
        api.get.mockRejectedValue(err);
        const s = harness();
        await flushPromises();
        expect(s().error.value).toBe(err);
        expect(s().loading.value).toBe(false);
    });
});
