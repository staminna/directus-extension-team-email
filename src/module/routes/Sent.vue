<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { useCurrentUser } from '../composables/useCurrentUser';
import EmailList from '../components/EmailList.vue';

const api = useApi();
const router = useRouter();
const { id: currentUserId } = useCurrentUser();

const items = ref<any[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
    if (!currentUserId.value) return;
    loading.value = true;
    error.value = null;
    try {
        const { data } = await api.get('/items/emails', {
            params: {
                filter: {
                    direction: { _eq: 'sent' },
                    owner: { _eq: currentUserId.value },
                },
                sort: '-date_created',
                limit: 100,
                fields: [
                    'id', 'direction', 'status', 'from_address', 'from_name',
                    'to_addresses', 'cc_addresses', 'subject', 'body_text', 'thread_id',
                    'is_read', 'date_created', 'sent_at', 'provider',
                ],
            },
        });
        items.value = data?.data ?? [];
    } catch (e: any) {
        error.value = e?.message ?? 'Could not load sent messages.';
    } finally {
        loading.value = false;
    }
}

function openThread(_id: string, threadId: string) {
    router.push({ name: 'email-thread', params: { id: threadId } });
}

async function deleteEmail(id: string) {
    if (!window.confirm('Delete this message?')) return;
    try {
        await api.delete(`/email/sent/${id}`);
        items.value = items.value.filter(r => r.id !== id);
    } catch (e: any) {
        error.value = e?.message ?? 'Could not delete the message.';
    }
}

onMounted(async () => {
    const wait = () => new Promise<void>((resolve) => {
        if (currentUserId.value) return resolve();
        const stop = setInterval(() => {
            if (currentUserId.value) { clearInterval(stop); resolve(); }
        }, 50);
    });
    await wait();
    await load();
});
</script>

<template>
    <div class="sent-view">
        <v-notice v-if="error" type="danger">{{ error }}</v-notice>
        <EmailList
            :items="items"
            :loading="loading"
            show-to
            :on-open="openThread"
            :on-delete="deleteEmail"
        />
    </div>
</template>

<style scoped>
.sent-view { padding: 16px; }
</style>
