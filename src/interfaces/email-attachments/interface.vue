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
    previewable,
} from '../../shared/attachments';

const props = defineProps<{
    value?: unknown;
    collection: string;
    field: string;
    primaryKey?: string | number | null;
}>();

const api = useApi();

const kind = computed(() => kindFor(props.collection));
const isNew = computed(() => props.primaryKey == null || props.primaryKey === '+');

const loading = ref(false);
const forbidden = ref(false);
const error = ref<string | null>(null);
const files = ref<AttachmentRow[]>([]);

async function load() {
    forbidden.value = false;
    error.value = null;
    files.value = [];
    if (isNew.value) return;
    loading.value = true;
    const r = await loadAttachments(api, props.primaryKey as string, kind.value);
    loading.value = false;
    if (r.state === 'ok') files.value = r.files;
    else if (r.state === 'forbidden') forbidden.value = true;
    else error.value = r.message;
}

function url(f: AttachmentRow, inline = false) {
    return attachmentUrl(api, props.primaryKey as string, f.id, kind.value, inline);
}

function hint(f: AttachmentRow) {
    const size = formatBytes(f.filesize);
    return `Descarregar ${f.filename}${size ? ` (${size})` : ''}`;
}

const totalSize = computed(() => files.value.reduce((n, f) => n + (f.filesize ?? 0), 0));

watch(() => props.primaryKey, load, { immediate: true });
</script>

<template>
    <div class="email-attachments">
        <v-notice v-if="isNew">Os anexos ficam disponíveis depois de a mensagem ser guardada.</v-notice>

        <v-notice v-else-if="forbidden" type="warning" icon="lock">
            Só o Administrativo e o Administrador podem descarregar os anexos da caixa partilhada.
        </v-notice>

        <div v-else-if="loading" class="buttons">
            <span v-for="n in 3" :key="n" class="file-btn skeleton" />
        </div>

        <v-notice v-else-if="error" type="danger">{{ error }}</v-notice>

        <div v-else-if="!files.length" class="empty">
            <v-icon name="attach_file" small />
            Sem anexos
        </div>

        <template v-else>
            <div class="buttons">
                <span v-for="f in files" :key="f.id" class="file">
                    <a class="file-btn" :href="url(f)" :title="hint(f)" download>
                        <v-icon :name="iconFor(f.type)" small />
                        <span class="name">{{ f.filename }}</span>
                        <span v-if="f.filesize != null" class="size">{{ formatBytes(f.filesize) }}</span>
                        <v-icon name="download" x-small class="dl" />
                    </a>
                    <a
                        v-if="previewable(f.type)"
                        class="open-btn"
                        :href="url(f, true)"
                        :title="`Abrir ${f.filename} num separador`"
                        target="_blank"
                        rel="noopener"
                    >
                        <v-icon name="open_in_new" x-small />
                    </a>
                </span>
            </div>
            <div class="summary">
                {{ files.length }} {{ files.length === 1 ? 'anexo' : 'anexos' }}<template v-if="totalSize"> · {{ formatBytes(totalSize) }}</template>
            </div>
        </template>
    </div>
</template>

<style scoped>
.email-attachments {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.empty {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--theme--foreground-subdued);
}

.buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.file {
    display: inline-flex;
    max-width: 100%;
}

.file-btn,
.open-btn {
    display: inline-flex;
    align-items: center;
    height: 36px;
    border: var(--theme--border-width) solid var(--theme--form--field--input--border-color, var(--theme--border-color));
    background: var(--theme--form--field--input--background, var(--theme--background));
    color: var(--theme--foreground);
    text-decoration: none;
    transition: border-color var(--fast) var(--transition), background-color var(--fast) var(--transition);
}

.file-btn {
    gap: 8px;
    min-width: 0;
    max-width: 100%;
    padding: 0 12px;
    border-radius: var(--theme--border-radius);
    font-weight: 600;
}

.file:has(.open-btn) .file-btn {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
}

.open-btn {
    justify-content: center;
    width: 36px;
    margin-left: calc(-1 * var(--theme--border-width));
    border-radius: 0 var(--theme--border-radius) var(--theme--border-radius) 0;
    color: var(--theme--foreground-subdued);
}

.file-btn:hover,
.open-btn:hover {
    position: relative;
    border-color: var(--theme--primary);
    background: var(--theme--primary-background, var(--theme--background-accent));
    color: var(--theme--primary);
}

.name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.size {
    flex: none;
    font-weight: 400;
    font-size: 12px;
    color: var(--theme--foreground-subdued);
}

.dl {
    flex: none;
    color: var(--theme--primary);
}

.skeleton {
    width: 160px;
    background: var(--theme--background-normal);
    animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
    50% {
        opacity: 0.5;
    }
}

.summary {
    color: var(--theme--foreground-subdued);
    font-size: 12px;
}
</style>
