<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRoute } from 'vue-router';
import EmailViewer from '../components/EmailViewer.vue';

const api = useApi();
const route = useRoute();

const items = ref<any[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const { data } = await api.get(`/email/threads/${route.params.id}`);
        items.value = data?.items ?? [];
    } catch (e: any) {
        error.value = e?.response?.data?.message || e?.message || 'Could not load the conversation.';
    } finally {
        loading.value = false;
    }
}

function formatDate(iso: string | null | undefined) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function recipients(item: any) {
    const tos = Array.isArray(item.to_addresses) ? item.to_addresses : [];
    return tos.map((a: any) => a.name || a.email).join(', ');
}

// Attachments live in a folder no permission grants read on, so /assets/:id is
// closed to everyone but the uploader. This route decides access per message
// instead. The base URL comes from the api instance rather than being fixed at
// the site root, which only works when Directus is mounted at the domain root.
function attachmentUrl(item: any, att: any) {
    const base = (api.defaults.baseURL || '/').replace(/\/$/, '');
    const kind = item?._kind === 'sent' ? 'sent' : 'received';
    const fileId = att?.directus_files_id?.id ?? att?.directus_files_id;
    return `${base}/email/message/${encodeURIComponent(item.id)}/attachment/${encodeURIComponent(fileId)}?kind=${kind}`;
}

function ccRecipients(item: any) {
    const ccs = Array.isArray(item.cc_addresses) ? item.cc_addresses : [];
    return ccs.map((a: any) => a.name || a.email).join(', ');
}

onMounted(load);
watch(() => route.params.id, load);
</script>

<template>
    <div class="thread-view">
        <v-notice v-if="error" type="danger">{{ error }}</v-notice>
        <div v-if="loading" class="loading">Loading…</div>
        <div v-else-if="!items.length" class="empty">Empty conversation.</div>

        <article v-for="item in items" :key="item.id" class="message">
            <header>
                <div class="from">
                    <strong>{{ item.from_name || item.from_address || '—' }}</strong>
                    <span class="kind" :class="item._kind">
                        {{ item._kind === 'sent' ? 'Sent' : 'Received' }}
                    </span>
                </div>
                <div class="meta">
                    <span class="to">to {{ recipients(item) }}</span>
                    <span v-if="ccRecipients(item)" class="to">cc {{ ccRecipients(item) }}</span>
                    <span class="date">{{ formatDate(item.date_created) }}</span>
                </div>
                <div class="subject">{{ item.subject || '(no subject)' }}</div>
            </header>
            <EmailViewer
                :message-id="item.id"
                :kind="item._kind"
                :body-html="item.body_html"
                :body-text="item.body_text"
            />

            <div v-if="item.attachments?.length" class="attachments">
                <a
                    v-for="att in item.attachments"
                    :key="att.directus_files_id?.id"
                    :href="attachmentUrl(item, att)"
                    target="_blank"
                    rel="noopener"
                    class="attachment"
                >
                    <v-icon name="attach_file" small />
                    {{ att.directus_files_id?.filename_download }}
                </a>
            </div>
        </article>
    </div>
</template>

<style scoped>
.thread-view { padding: 16px; max-width: 900px; }
.message { background: var(--theme--background); border: 1px solid var(--theme--border-color-subdued); border-radius: 6px; padding: 16px; margin-bottom: 16px; }
.message header { margin-bottom: 12px; }
.from { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.kind { font-size: 11px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
.kind.sent { background: rgba(46,205,167,0.15); color: #2ECDA7; }
.kind.received { background: rgba(51,153,255,0.15); color: #3399FF; }
.meta { display: flex; justify-content: space-between; color: var(--theme--foreground-subdued); font-size: 13px; margin-top: 4px; }
.subject { margin-top: 8px; font-size: 16px; font-weight: 600; }
.attachments { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.attachment { display: inline-flex; align-items: center; gap: 4px; padding: 6px 10px; border: 1px solid var(--theme--border-color-subdued); border-radius: 4px; text-decoration: none; color: inherit; font-size: 13px; }
.attachment:hover { background: var(--theme--background-subdued); }
.loading, .empty { padding: 32px; text-align: center; color: var(--theme--foreground-subdued); }
</style>
