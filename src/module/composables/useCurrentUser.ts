import { ref, onMounted } from 'vue';
import { useApi } from '@directus/extensions-sdk';

export function useCurrentUser() {
    const api = useApi();
    const id = ref<string | null>(null);
    const loading = ref(true);
    const error = ref<unknown>(null);

    onMounted(async () => {
        try {
            const { data } = await api.get('/users/me', { params: { fields: ['id'] } });
            id.value = data?.data?.id ?? null;
        } catch (e) {
            error.value = e;
        } finally {
            loading.value = false;
        }
    });

    return { id, loading, error };
}
