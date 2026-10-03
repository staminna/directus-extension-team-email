<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';

type Mode = 'external' | 'internal';
type SuggestField = 'to' | 'cc' | 'internal';

const api = useApi();
const router = useRouter();

// Internal messages are the ones that reach the recipient's Directus inbox
// immediately, with no mail server involved, so that is the default.
const mode = ref<Mode>('internal');
const subject = ref('');
const bodyText = ref('');
const bodyHtml = ref('');
const htmlMode = ref(true);
const replyTo = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

// The rich text interface renders whatever toolbar it is given; mounted bare it
// gets none, which is why there was no way to insert an image. `customImage`
// is the Directus image tool (it uploads into directus_files and inserts the
// asset URL).
const richToolbar = [
    'bold', 'italic', 'underline', 'removeformat',
    'h1', 'h2', 'h3', 'numlist', 'bullist', 'blockquote',
    'customLink', 'customImage', 'customMedia',
    'hr', 'code', 'fullscreen',
];

// ── attachments ──
// v-upload covers both halves of this in one component: the OS file dialog
// (from-user) and the existing file library (from-library). Its @input always
// hands back full directus_files records, an array when multiple, and null on
// failure — every source path is normalised to that.
const attachments = ref<any[]>([]);
const attachmentsFolder = ref<string | null>(null);
const maxAttachmentBytes = ref(26_214_400);
const uploading = ref(false);

const attachmentBytes = computed(() =>
    attachments.value.reduce((n, f) => n + Number(f?.filesize ?? 0), 0));
const overLimit = computed(() => attachmentBytes.value > maxAttachmentBytes.value);

function formatBytes(n: number) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function onAttachmentsPicked(picked: any) {
    uploading.value = false;
    if (!picked) {
        error.value = 'The file could not be attached.';
        return;
    }
    const list = Array.isArray(picked) ? picked : [picked];
    for (const f of list) {
        if (f?.id && !attachments.value.some(a => a.id === f.id)) attachments.value.push(f);
    }
}

function removeAttachment(id: string) {
    attachments.value = attachments.value.filter(a => a.id !== id);
}

async function loadConfig() {
    try {
        const { data } = await api.get('/email/config');
        attachmentsFolder.value = data?.attachments_folder ?? null;
        if (data?.max_attachment_bytes) maxAttachmentBytes.value = Number(data.max_attachment_bytes);
    } catch {
        // Falls back to uploading with no folder and the default cap.
    }
}

// external mode
const to = ref(''); // comma-separated emails
const cc = ref('');

// internal mode
const selectedUsers = ref<any[]>([]);
const userQuery = ref('');

// ── internal users cache (loaded once, filtered client-side) ──
const allUsers = ref<any[]>([]);
const usersLoaded = ref(false);
// Surfaced in the UI: a picker that silently offers nothing is indistinguishable
// from one that is simply still loading.
const suggestError = ref<string | null>(null);

async function loadInternalUsers() {
    if (usersLoaded.value) return;

    // /email/recipients resolves the list server-side. Asking /users directly
    // only works for people whose policy grants a broad read on directus_users;
    // a typical non-admin policy narrows it to the current user, which leaves
    // the picker able to suggest only the sender and looking broken. /users
    // stays as a fallback.
    try {
        const { data } = await api.get('/email/recipients');
        allUsers.value = data?.data ?? [];
        usersLoaded.value = allUsers.value.length > 0;
        if (usersLoaded.value) return;
    } catch {
        // fall through to /users
    }

    try {
        const { data } = await api.get('/users', {
            params: {
                fields: ['id', 'email', 'first_name', 'last_name'],
                filter: { status: { _eq: 'active' } },
                sort: 'first_name',
                limit: 200,
            },
        });
        allUsers.value = (data?.data ?? []).filter((u: any) => !!u.email);
        usersLoaded.value = true;
    } catch (e: any) {
        allUsers.value = [];
        suggestError.value = 'Could not load the list of users.';
    }
}

// ── autocomplete (partilhado pelos campos to / cc / internal) ──
const activeField = ref<SuggestField | null>(null);
const activeIndex = ref(0);

function matches(u: any, q: string) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').toLowerCase();
    return u.email.toLowerCase().includes(q) || name.includes(q);
}

function tokens(value: string) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
}

function lastToken(value: string) {
    const parts = value.split(',');
    return parts[parts.length - 1].trim().toLowerCase();
}

const suggestions = computed(() => {
    if (!activeField.value || !allUsers.value.length) return [];

    if (activeField.value === 'internal') {
        const q = userQuery.value.trim().toLowerCase();
        const picked = new Set(selectedUsers.value.map(u => u.id));
        return allUsers.value
            .filter(u => !picked.has(u.id) && (!q || matches(u, q)))
            .slice(0, 8);
    }

    const source = activeField.value === 'to' ? to.value : cc.value;
    const other = activeField.value === 'to' ? cc.value : to.value;
    const q = lastToken(source);
    if (!q) return [];
    // Everything already addressed, in either field. Offering a person who is
    // already in To while the user is filling Cc put them in both, and they
    // received the message twice.
    const present = new Set(
        [...tokens(source).slice(0, -1), ...tokens(other)].map(s => s.toLowerCase())
    );
    return allUsers.value
        .filter(u => !present.has(u.email.toLowerCase()) && matches(u, q))
        .slice(0, 8);
});

// The highlighted row must stay inside the list. Typing another letter shrinks
// the suggestions, and without this Enter reached past the end and threw.
watch(suggestions, (list) => {
    if (activeIndex.value >= list.length) activeIndex.value = 0;
});

function openSuggest(field: SuggestField) {
    activeField.value = field;
    activeIndex.value = 0;
}

function closeDropdown() {
    activeField.value = null;
    activeIndex.value = 0;
}

function applySuggestion(u: any) {
    if (!activeField.value || !u) return;
    if (activeField.value === 'internal') {
        pickUser(u);
    } else {
        const target = activeField.value === 'to' ? to : cc;
        const parts = tokens(target.value);
        parts.pop(); // substitui o token parcial
        parts.push(u.email);
        target.value = parts.join(', ') + ', ';
    }
    activeIndex.value = 0;
}

function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
        closeDropdown();
        return;
    }
    const list = suggestions.value;
    if (!list.length) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex.value = (activeIndex.value + 1) % list.length;
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex.value = (activeIndex.value - 1 + list.length) % list.length;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(list[activeIndex.value]);
    }
}

function userLabel(u: any) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    return name ? `${name} <${u.email}>` : u.email;
}

function pickUser(u: any) {
    if (!selectedUsers.value.find(x => x.id === u.id)) {
        selectedUsers.value.push(u);
    }
    userQuery.value = '';
}

function removeUser(id: string) {
    selectedUsers.value = selectedUsers.value.filter(u => u.id !== id);
}

function onDocPointerDown(e: MouseEvent) {
    const el = e.target as Element | null;
    if (!el || !el.closest('.suggest-root')) closeDropdown();
}

onMounted(() => {
    loadInternalUsers();
    loadConfig();
    document.addEventListener('mousedown', onDocPointerDown, true);
});

onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDocPointerDown, true);
});

const canSubmit = computed(() => {
    if (!subject.value || (!bodyText.value && !bodyHtml.value) || submitting.value) return false;
    if (uploading.value || overLimit.value) return false;
    if (mode.value === 'external') return to.value.trim().length > 0;
    return selectedUsers.value.length > 0;
});

function csv(value: string) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
}

async function submit() {
    if (!canSubmit.value) return;
    submitting.value = true;
    error.value = null;
    success.value = null;
    try {
        if (mode.value === 'external') {
            const payload: any = {
                to: csv(to.value),
                subject: subject.value,
            };
            if (cc.value.trim()) payload.cc = csv(cc.value);
            if (attachments.value.length) payload.attachment_ids = attachments.value.map(a => a.id);
            if (htmlMode.value) payload.html = bodyHtml.value;
            else payload.text = bodyText.value;
            if (replyTo.value) payload.in_reply_to = replyTo.value;
            const { data } = await api.post('/email/send', payload);
            success.value = `Sent (id ${data?.id ?? '—'}).`;
            setTimeout(() => router.push('/email/sent'), 800);
        } else {
            const payload: any = {
                to_user: selectedUsers.value.map(u => u.id),
                subject: subject.value,
            };
            if (htmlMode.value) payload.body_html = bodyHtml.value;
            else payload.body_text = bodyText.value;
            if (attachments.value.length) payload.attachment_ids = attachments.value.map(a => a.id);
            const { data } = await api.post('/email/internal/send', payload);
            success.value = `Internal message sent (thread ${data?.thread_id ?? '—'}).`;
            setTimeout(() => router.push('/email/sent'), 800);
        }
    } catch (e: any) {
        error.value = e?.response?.data?.message || e?.message || 'Could not send the message.';
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <div class="compose-view">
        <div class="mode-tabs">
            <v-button
                :secondary="mode !== 'internal'"
                @click="mode = 'internal'; closeDropdown()"
                small
            >Internal</v-button>
            <v-button
                :secondary="mode !== 'external'"
                @click="mode = 'external'; closeDropdown()"
                small
            >External</v-button>
        </div>

        <v-notice v-if="error" type="danger">{{ error }}</v-notice>
        <v-notice v-if="success" type="success">{{ success }}</v-notice>
        <v-notice v-if="suggestError" type="warning">{{ suggestError }}</v-notice>

        <div v-if="mode === 'external'" class="field">
            <label>To</label>
            <div class="user-picker suggest-root">
                <v-input
                    v-model="to"
                    placeholder="name@example.com, other@example.com"
                    @focus="openSuggest('to')"
                    @keydown="onFieldKeydown"
                />
                <div v-if="activeField === 'to' && suggestions.length" class="user-dropdown">
                    <button
                        v-for="(u, i) in suggestions"
                        :key="u.id"
                        class="user-option"
                        :class="{ active: i === activeIndex }"
                        type="button"
                        @mousedown.prevent="applySuggestion(u)"
                        @mousemove="activeIndex = i"
                    >{{ userLabel(u) }}</button>
                </div>
            </div>
        </div>
        <div v-if="mode === 'external'" class="field">
            <label>Cc</label>
            <div class="user-picker suggest-root">
                <v-input
                    v-model="cc"
                    placeholder="cc@example.com"
                    @focus="openSuggest('cc')"
                    @keydown="onFieldKeydown"
                />
                <div v-if="activeField === 'cc' && suggestions.length" class="user-dropdown">
                    <button
                        v-for="(u, i) in suggestions"
                        :key="u.id"
                        class="user-option"
                        :class="{ active: i === activeIndex }"
                        type="button"
                        @mousedown.prevent="applySuggestion(u)"
                        @mousemove="activeIndex = i"
                    >{{ userLabel(u) }}</button>
                </div>
            </div>
        </div>

        <div v-else class="field">
            <label>To (users)</label>
            <div class="user-picker suggest-root">
                <div class="chips">
                    <span v-for="u in selectedUsers" :key="u.id" class="chip">
                        {{ userLabel(u) }}
                        <button class="chip-x" @click="removeUser(u.id)" type="button">×</button>
                    </span>
                </div>
                <v-input
                    v-model="userQuery"
                    placeholder="Search users…"
                    @focus="openSuggest('internal')"
                    @keydown="onFieldKeydown"
                />
                <div v-if="activeField === 'internal' && suggestions.length" class="user-dropdown">
                    <button
                        v-for="(u, i) in suggestions"
                        :key="u.id"
                        class="user-option"
                        :class="{ active: i === activeIndex }"
                        type="button"
                        @mousedown.prevent="applySuggestion(u)"
                        @mousemove="activeIndex = i"
                    >{{ userLabel(u) }}</button>
                </div>
            </div>
        </div>

        <div class="field">
            <label>Subject</label>
            <v-input v-model="subject" placeholder="Subject" />
        </div>

        <div class="field">
            <label>
                Body
                <v-checkbox v-model="htmlMode" label="HTML" />
            </label>
            <v-textarea v-if="!htmlMode" v-model="bodyText" :rows="12" />
            <interface-input-rich-text-html
                v-else
                :value="bodyHtml"
                :toolbar="richToolbar"
                @input="bodyHtml = $event"
            />
        </div>

        <div class="field">
            <label>
                Attachments
                <span v-if="attachments.length" class="att-total" :class="{ over: overLimit }">
                    {{ attachments.length }} file{{ attachments.length === 1 ? '' : 's' }},
                    {{ formatBytes(attachmentBytes) }} of {{ formatBytes(maxAttachmentBytes) }}
                </span>
            </label>

            <div v-if="attachments.length" class="chips">
                <span v-for="f in attachments" :key="f.id" class="chip">
                    <v-icon name="attach_file" x-small />
                    {{ f.filename_download || f.title || f.id }}
                    <span class="chip-size">{{ formatBytes(Number(f.filesize ?? 0)) }}</span>
                    <button class="chip-x" type="button" @click="removeAttachment(f.id)">×</button>
                </span>
            </div>

            <!-- One control, both sources: from-user opens the OS file dialog,
                 from-library opens the Directus file library. -->
            <v-upload
                multiple
                from-user
                from-library
                :folder="attachmentsFolder"
                @start="uploading = true"
                @input="onAttachmentsPicked"
            />

            <v-notice v-if="overLimit" type="danger">
                Attachments are {{ formatBytes(attachmentBytes) }}, over the
                {{ formatBytes(maxAttachmentBytes) }} limit. Remove one to send.
            </v-notice>
        </div>

        <div class="field actions">
            <v-button :disabled="!canSubmit" :loading="submitting" @click="submit">
                Send
            </v-button>
        </div>
    </div>
</template>

<style scoped>
.compose-view { padding: 24px; max-width: 800px; }
.mode-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.field { margin-bottom: 16px; }
.field label { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--theme--foreground-subdued); margin-bottom: 6px; }
.user-picker { position: relative; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.chip { background: var(--theme--background-subdued); padding: 4px 8px; border-radius: 4px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
.chip-x { border: 0; background: transparent; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; }
/* In normal flow, not absolute. An overlay dropdown sits on top of the field
   below it — with To open, a click aimed at Cc landed on a To suggestion and
   Cc never even got focus. Pushing the form down instead costs a little
   movement and removes the whole class of mis-click. */
.user-dropdown {
    margin-top: 4px;
    background: var(--theme--background); border: 1px solid var(--theme--border-color);
    border-radius: 4px; max-height: 240px; overflow-y: auto;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
}
.user-option { display: block; width: 100%; text-align: left; padding: 8px 12px; border: 0; background: transparent; cursor: pointer; color: var(--theme--foreground); font-size: 14px; }
.user-option:hover, .user-option.active { background: var(--theme--background-subdued); }
.actions { margin-top: 24px; }
.att-total { font-size: 12px; color: var(--theme--foreground-subdued); }
.att-total.over { color: var(--theme--danger); font-weight: 600; }
.chip-size { font-size: 11px; color: var(--theme--foreground-subdued); }
</style>
