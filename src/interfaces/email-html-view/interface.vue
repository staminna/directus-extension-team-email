<script setup lang="ts">
import { computed } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import EmailFrame from '../../shared/EmailFrame.vue';

const props = withDefaults(defineProps<{
    value: string | null;
    disabled?: boolean;
    collection?: string;
    field?: string;
    primaryKey?: string | number | null;
    kind?: 'auto' | 'received' | 'sent';
    minHeight?: number;
}>(), {
    disabled: false,
    kind: 'auto',
    minHeight: 160,
});

const api = useApi();

/** A real, saved item id — '+' is what Directus passes while creating. */
const savedId = computed(() => {
    const pk = props.primaryKey;
    if (pk == null || pk === '' || pk === '+') return null;
    return String(pk);
});

const resolvedKind = computed<'received' | 'sent'>(() => {
    if (props.kind === 'sent' || props.kind === 'received') return props.kind;
    return props.collection === 'emails' ? 'sent' : 'received';
});

/**
 * Served as its own document so it gets a mail-friendly CSP (images from
 * anywhere, no scripts). The value's length in the query string makes the
 * frame refetch after the body is edited elsewhere and saved (60 s cache).
 */
const src = computed(() => {
    if (!savedId.value) return null;
    const base = (api.defaults.baseURL || '/').replace(/\/$/, '');
    return `${base}/email/message/${encodeURIComponent(savedId.value)}/body?kind=${resolvedKind.value}&v=${(props.value ?? '').length}`;
});

/** Unsaved item: render the value directly (remote images stay blocked by the app CSP). */
const srcdoc = computed(() => {
    const body = props.value ?? '';
    return `<!doctype html><html><head><meta charset="utf-8">`
        + `<style>html,body{margin:0;padding:12px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;background:#fff}img{max-width:100%;height:auto}table{max-width:100%}</style>`
        + `</head><body>${body}</body></html>`;
});

const isEmpty = computed(() => !(props.value ?? '').trim() && !savedId.value);
</script>

<template>
    <div class="email-html-view">
        <v-notice v-if="isEmpty" type="info">No HTML body.</v-notice>
        <EmailFrame v-else :src="src" :srcdoc="srcdoc" :min-height="minHeight" />
    </div>
</template>

<style scoped>
.email-html-view { display: block; }
</style>
