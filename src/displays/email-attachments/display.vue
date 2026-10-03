<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import {
    type AttachmentRow,
    attachmentUrl,
    formatBytes,
    iconFor,
    kindFor,
    loadAttachments,
} from '../../shared/attachments';

const props = defineProps<{
    value?: Array<Record<string, any>> | null;
    collection: string;
    field: string;
}>();

const api = useApi();
const kind = computed(() => kindFor(props.collection));
const fk = computed(() => (props.collection === 'emails' ? 'emails_id' : 'inbox_email_id'));

const rows = computed(() => (Array.isArray(props.value) ? props.value : []));
const count = computed(() => rows.value.length);
const messageId = computed(() => {
    const first = rows.value[0]?.[fk.value];
    return first?.id ?? first ?? null;
});

const open = ref(false);
const loaded = ref(false);
const loading = ref(false);
const forbidden = ref(false);
const error = ref<string | null>(null);
const files = ref<AttachmentRow[]>([]);

async function load() {
    if (loaded.value || loading.value || messageId.value == null) return;
    error.value = null;
    loading.value = true;
    const r = await loadAttachments(api, messageId.value, kind.value);
    loading.value = false;
    loaded.value = true;
    if (r.state === 'ok') files.value = r.files;
    else if (r.state === 'forbidden') forbidden.value = true;
    else {
        error.value = r.message;
        loaded.value = false; // let a reopen retry
    }
}

function url(f: AttachmentRow) {
    return attachmentUrl(api, messageId.value as string, f.id, kind.value);
}

watch(open, v => {
    if (v) load();
});
// Rows are recycled when the list pages or re-sorts.
watch(messageId, () => {
    loaded.value = false;
    files.value = [];
    forbidden.value = false;
    error.value = null;
});
</script>

<template>
    <span v-if="!count" class="none">—</span>
    <v-menu v-else v-model="open" show-arrow placement="bottom-start">
        <template #activator="{ toggle }">
            <button
                type="button"
                class="clip"
                :title="`${count} ${count === 1 ? 'anexo' : 'anexos'} — clique para descarregar`"
                @click.stop.prevent="toggle"
            >
                <v-icon name="attach_file" x-small />
                <span>{{ count }}</span>
            </button>
        </template>

        <div class="menu" @click.stop>
            <div v-if="loading" class="state">A carregar…</div>
            <div v-else-if="forbidden" class="state">
                <v-icon name="lock" x-small /> Só Administrativo e Administrador
            </div>
            <div v-else-if="error" class="state danger">{{ error }}</div>
            <div v-else-if="loaded && !files.length" class="state">Sem anexos</div>
            <template v-else>
                <a
                    v-for="f in files"
                    :key="f.id"
                    class="row"
                    :href="url(f)"
                    download
                    @click="open = false"
                >
                    <v-icon :name="iconFor(f.type)" small />
                    <span class="name">{{ f.filename }}</span>
                    <span class="size">{{ formatBytes(f.filesize) }}</span>
                    <v-icon name="download" small class="dl" />
                </a>
            </template>
        </div>
    </v-menu>
</template>

<style scoped>
.none {
    color: var(--theme--foreground-subdued);
}

.clip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    height: 22px;
    border-radius: 11px;
    background: var(--theme--background-normal);
    color: var(--theme--foreground);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
}

.clip:hover {
    background: var(--theme--primary-background, var(--theme--background-accent));
    color: var(--theme--primary);
}

.menu {
    min-width: 260px;
    max-width: 420px;
    max-height: 320px;
    overflow: auto;
    padding: 4px;
}

.state {
    padding: 8px 10px;
    color: var(--theme--foreground-subdued);
    display: flex;
    align-items: center;
    gap: 6px;
}

.state.danger {
    color: var(--theme--danger);
}

.row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--theme--border-radius);
    color: var(--theme--foreground);
    text-decoration: none;
}

.row:hover {
    background: var(--theme--background-normal);
}

.name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.size {
    flex: none;
    font-size: 12px;
    color: var(--theme--foreground-subdued);
}

.dl {
    flex: none;
    color: var(--theme--primary);
}
</style>
