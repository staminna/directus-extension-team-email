<script setup lang="ts">
import { computed } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import EmailFrame from '../../shared/EmailFrame.vue';

const api = useApi();

const props = defineProps<{
    bodyHtml?: string | null;
    bodyText?: string | null;
    messageId?: string | null;
    kind?: string | null;
}>();

// Preferred path: load the body from /email/message/:id/body, which serves it as
// its own document with a policy written for mail, so remote images render.
// Inlining with srcdoc instead makes the frame inherit the Directus app's
// Content-Security-Policy, which allows images from only a handful of hosts and
// leaves every real HTML email full of broken pictures.
const src = computed(() => {
    if (!props.messageId) return null;
    const kind = props.kind === 'sent' ? 'sent' : 'received';
    // From the api instance, not the site root: a Directus mounted under a
    // sub-path would otherwise get a URL pointing outside the app.
    const base = (api.defaults.baseURL || '/').replace(/\/$/, '');
    return `${base}/email/message/${encodeURIComponent(props.messageId)}/body?kind=${kind}`;
});

// Fallback for callers that have the body but no id.
const srcdoc = computed(() => {
    if (props.bodyHtml) return props.bodyHtml;
    const text = props.bodyText ?? '';
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap; padding: 12px;">${escaped}</pre>`;
});
</script>

<template>
    <!-- Opens at the message's full height in one go; the page scrolls, the frame never does. -->
    <EmailFrame :src="src" :srcdoc="srcdoc" :min-height="120" />
</template>
