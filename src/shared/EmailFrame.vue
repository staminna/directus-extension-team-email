<script setup lang="ts">
/**
 * Team Email — EmailFrame
 * ------------------------------------------------------------------
 * Renders an email body in a sandboxed frame that opens at the message's
 * full height in one go: no inner scrollbar, no incremental growth.
 *
 * The frame loads hidden, and tall enough that every image in the message —
 * lazy ones included, which only fetch once they are near the frame's own
 * viewport — has loaded by the time `load` fires. It is then measured once
 * and shown at its final height.
 *
 * `src` should point at GET /email/message/:id/body: a same-origin document
 * (which is what lets the parent measure it) carrying a Content-Security-
 * Policy written for mail. The sandbox withholds scripts and forms either
 * way; links open in a new, unsandboxed tab. `srcdoc` is the fallback for
 * a body with no id.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
    src?: string | null;
    srcdoc?: string | null;
    minHeight?: number;
}>(), {
    src: null,
    srcdoc: null,
    minHeight: 160,
});

const MEASURE_HEIGHT = 6000;
const REVEAL_FALLBACK_MS = 10_000;

const frame = ref<HTMLIFrameElement | null>(null);
const ready = ref(false);
const height = ref(0);

let observer: ResizeObserver | null = null;
let fallbackTimer: number | null = null;

const floor = computed(() => Math.max(60, Number(props.minHeight) || 160));

function measure(): number {
    const doc = frame.value?.contentDocument;
    const html = doc?.documentElement;
    const body = doc?.body;
    if (!doc || !html || !body) return 0;
    // The root box is stretched to the (tall, hidden) viewport, so the body is
    // what carries the content height. Add the root's own padding.
    const cs = doc.defaultView?.getComputedStyle(html);
    const pad = (parseFloat(cs?.paddingTop || '0') || 0) + (parseFloat(cs?.paddingBottom || '0') || 0);
    return Math.ceil(Math.max(body.scrollHeight, Math.ceil(body.getBoundingClientRect().height)) + pad);
}

function applyHeight() {
    const h = measure();
    if (h > 0) height.value = Math.max(floor.value, h + 2);
    else if (!height.value) height.value = floor.value;
}

function armFallback() {
    if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
    // Never leave the message blank if the network stalls: show what there is.
    fallbackTimer = window.setTimeout(() => { applyHeight(); reveal(); }, REVEAL_FALLBACK_MS);
}

function reveal() {
    if (fallbackTimer != null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
    }
    ready.value = true;
}

function detach() {
    observer?.disconnect();
    observer = null;
}

// Links open in a new tab. Inside the frame most sites refuse to be framed
// (X-Frame-Options) and Chrome shows "This content is blocked" instead.
function openLinksInNewTab(doc: Document | null | undefined) {
    if (!doc?.head || doc.querySelector('base[target]')) return;
    const base = doc.createElement('base');
    base.target = '_blank';
    doc.head.prepend(base);
}

function onLoad() {
    detach();
    const doc = frame.value?.contentDocument;
    openLinksInNewTab(doc);
    // Let the final layout settle for one frame, then size and show together.
    requestAnimationFrame(() => {
        applyHeight();
        reveal();
        // Anything that reflows later (a slow web font, say) adjusts silently.
        if (doc && 'ResizeObserver' in window) {
            observer = new ResizeObserver(() => { if (ready.value) applyHeight(); });
            if (doc.body) observer.observe(doc.body);
        }
    });
}

// A new document (different message, edited body): hide, reload, re-measure.
watch(() => [props.src, props.srcdoc], () => {
    detach();
    ready.value = false;
    armFallback();
});

onMounted(armFallback);
onBeforeUnmount(() => {
    detach();
    if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
});

const frameStyle = computed(() => ready.value
    ? { height: `${height.value}px` }
    : { height: `${MEASURE_HEIGHT}px`, position: 'absolute', top: '0', left: '0', visibility: 'hidden', pointerEvents: 'none' } as Record<string, string>);
</script>

<template>
    <div class="email-frame-host" :class="{ loading: !ready }" :style="ready ? undefined : { minHeight: `${floor}px` }">
        <v-progress-circular v-if="!ready" class="spinner" indeterminate />
        <iframe
            v-if="src"
            ref="frame"
            class="email-frame"
            :style="frameStyle"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            scrolling="no"
            referrerpolicy="no-referrer"
            :src="src"
            title="Email body"
            @load="onLoad"
        />
        <iframe
            v-else
            ref="frame"
            class="email-frame"
            :style="frameStyle"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            scrolling="no"
            referrerpolicy="no-referrer"
            :srcdoc="srcdoc ?? ''"
            title="Email body"
            @load="onLoad"
        />
    </div>
</template>

<style scoped>
.email-frame-host { display: block; position: relative; }
.email-frame-host.loading { overflow: hidden; }
.spinner { position: absolute; top: 16px; left: 16px; }
.email-frame {
    width: 100%;
    display: block;
    overflow: hidden;
    border: 1px solid var(--theme--border-color-subdued);
    border-radius: 6px;
    background: #fff;
}
</style>
