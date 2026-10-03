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
        const { data } = await api.get('/items/inbox_email', {
            params: {
                filter: { owner: { _eq: currentUserId.value } },
                // By arrival time, not row-insert time: an import or a backfill
                // would otherwise pile up at the top in insertion order.
                sort: '-received_at',
                limit: 100,
                fields: [
                    'id', 'source', 'from_address', 'from_name',
                    'to_addresses', 'cc_addresses', 'subject', 'body_text', 'thread_id',
                    'is_read', 'date_created', 'received_at',
                ],
            },
        });
        items.value = data?.data ?? [];
    } catch (e: any) {
        error.value = e?.message ?? 'Could not load the inbox.';
    } finally {
        loading.value = false;
    }
}

async function toggleRead(id: string, isRead: boolean) {
    try {
        await api.post(`/email/inbox/${id}/${isRead ? 'read' : 'unread'}`);
        const row = items.value.find(r => r.id === id);
        if (row) row.is_read = isRead;
    } catch (e) {
        // surface elsewhere if needed
    }
}

async function deleteEmail(id: string) {
    if (!window.confirm('Delete this message?')) return;
    try {
        await api.delete(`/email/inbox/${id}`);
        items.value = items.value.filter(r => r.id !== id);
    } catch (e: any) {
        error.value = e?.response?.data?.message ?? e?.message ?? 'Could not delete the message.';
    }
}

const syncing = ref(false);
const syncNote = ref<string | null>(null);

/**
 * Pull new mail from the user's IMAP mailbox, then reload if anything
 * arrived. 404 = no mailbox configured, which is fine; the server also
 * throttles calls closer together than EMAIL_IMAP_MIN_INTERVAL_SECONDS.
 * IMAP_SYNC_ON_OPEN
 */
async function syncMailbox(force = false) {
    if (syncing.value) return;
    syncing.value = true;
    syncNote.value = null;
    try {
        const { data } = await api.post('/email/imap/sync', null, { params: force ? { force: 1 } : {} });
        if (data?.status === 'ok' && (data.stored > 0 || force)) await load();
        if (data?.status === 'ok' && force) syncNote.value = data.stored > 0 ? `${data.stored} new message(s)` : 'Up to date';
    } catch (e: any) {
        const status = e?.response?.status;
        if (status !== 404 && status !== 503) {
            syncNote.value = e?.response?.data?.error ?? e?.response?.data?.message ?? 'Mailbox sync failed';
        }
    } finally {
        syncing.value = false;
    }
}

function openThread(id: string, threadId: string) {
    toggleRead(id, true);
    router.push({ name: 'email-thread', params: { id: threadId } });
}

onMounted(async () => {
    // Wait for currentUserId via interval-free polling
    const wait = () => new Promise<void>((resolve) => {
        if (currentUserId.value) return resolve();
        const stop = setInterval(() => {
            if (currentUserId.value) { clearInterval(stop); resolve(); }
        }, 50);
    });
    await wait();
    await load();
    // Fresh mail from IMAP, without blocking the first paint.
    syncMailbox();
});
</script>

<template>
    <div class="inbox-view">
        <v-notice v-if="error" type="danger">{{ error }}</v-notice>
        <div class="inbox-toolbar">
            <v-button x-small secondary :loading="syncing" :disabled="syncing" @click="syncMailbox(true)">
                <v-icon name="sync" small left /> Check mailbox
            </v-button>
            <span v-if="syncNote" class="inbox-sync-note">{{ syncNote }}</span>
        </div>
        <EmailList
            :items="items"
            :loading="loading"
            show-from
            :on-open="openThread"
            :on-toggle-read="toggleRead"
            :on-delete="deleteEmail"
        />
    </div>
</template>

<style scoped>
.inbox-view { padding: 16px; }
.inbox-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.inbox-sync-note { color: var(--theme--foreground-subdued); font-size: 12px; }
</style>
