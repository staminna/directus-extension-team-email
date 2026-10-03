<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
    items: any[];
    loading?: boolean;
    showFrom?: boolean;
    showTo?: boolean;
    onOpen?: (id: string, threadId: string) => void;
    onToggleRead?: (id: string, isRead: boolean) => void;
    onDelete?: (id: string) => void;
}>();

const rows = computed(() => props.items ?? []);

function preview(text: string | null | undefined) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').slice(0, 140);
}

function formatDate(iso: string | null | undefined) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function recipientLabel(toAddrs: any) {
    if (!Array.isArray(toAddrs) || toAddrs.length === 0) return '';
    return toAddrs.map((a: any) => a.name || a.email).join(', ');
}
</script>

<template>
    <div class="email-list">
        <div v-if="loading" class="loading">Loading…</div>
        <div v-else-if="rows.length === 0" class="empty">No messages.</div>
        <div
            v-for="row in rows"
            :key="row.id"
            class="email-row"
            :class="{ unread: !row.is_read }"
            @click="props.onOpen?.(row.id, row.thread_id)"
        >
            <div class="meta">
                <template v-if="showFrom">
                    <span class="addr">{{ row.from_name || row.from_address || '—' }}</span>
                    <!-- Which address this arrived at. Mail forwarded from a
                         shared mailbox is otherwise indistinguishable from
                         someone's personal mail. -->
                    <span v-if="recipientLabel(row.to_addresses)" class="to-addr">
                        to {{ recipientLabel(row.to_addresses) }}
                        <template v-if="recipientLabel(row.cc_addresses)">
                            · cc {{ recipientLabel(row.cc_addresses) }}
                        </template>
                    </span>
                </template>
                <span v-else-if="showTo" class="addr">{{ recipientLabel(row.to_addresses) }}</span>
                <span class="date">{{ formatDate(row.received_at || row.sent_at || row.date_created) }}</span>
            </div>
            <div class="subject">{{ row.subject || '(no subject)' }}</div>
            <div class="preview">{{ preview(row.body_text || row.body_html) }}</div>
            <div v-if="showFrom" class="actions" @click.stop>
                <v-button
                    x-small
                    secondary
                    icon
                    @click="props.onToggleRead?.(row.id, !row.is_read)"
                >
                    <v-icon :name="row.is_read ? 'mark_email_unread' : 'mark_email_read'" small />
                </v-button>
                <v-button
                    v-if="props.onDelete"
                    x-small
                    secondary
                    icon
                    @click="props.onDelete?.(row.id)"
                >
                    <v-icon name="delete" small />
                </v-button>
            </div>
            <div v-else-if="props.onDelete" class="actions" @click.stop>
                <v-button
                    x-small
                    secondary
                    icon
                    @click="props.onDelete?.(row.id)"
                >
                    <v-icon name="delete" small />
                </v-button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.email-list { display: flex; flex-direction: column; gap: 1px; }
.email-row {
    padding: 12px 16px;
    background: var(--theme--background);
    border-bottom: 1px solid var(--theme--border-color-subdued);
    cursor: pointer;
    position: relative;
}
.email-row:hover { background: var(--theme--background-subdued); }
.email-row.unread { font-weight: 600; }
.email-row.unread::before {
    content: '';
    position: absolute; left: 4px; top: 50%;
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--theme--primary);
    transform: translateY(-50%);
}
.meta { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--theme--foreground-subdued); }
.addr { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.to-addr { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; opacity: 0.75; }
.date { flex: 0 0 auto; margin-left: auto; }
.subject { margin-top: 2px; font-size: 15px; }
.preview { margin-top: 4px; font-size: 13px; color: var(--theme--foreground-subdued); font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.email-row .actions { opacity: 0.4; }
.email-row:hover .actions { opacity: 1; }
.loading, .empty { padding: 32px; text-align: center; color: var(--theme--foreground-subdued); }
</style>
