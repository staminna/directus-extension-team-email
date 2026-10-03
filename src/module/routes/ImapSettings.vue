<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { onBeforeRouteLeave } from 'vue-router';

interface AccountPublic {
    id: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    mailbox: string;
    is_active: boolean;
    initial_days: number | null;
    has_password: boolean;
    last_uid: number;
    last_sync_at: string | null;
    last_sync_status: string;
    last_error: string | null;
    syncing?: boolean;
}

const api = useApi();

const loading = ref(true);
const busy = ref<null | 'test' | 'save' | 'sync' | 'remove'>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const noticeType = ref<'success' | 'warning'>('success');
const savedSnapshot = ref('');

const account = ref<AccountPublic | null>(null);
const secretConfigured = ref(true);
const allowedDomains = ref<string[]>([]);

const form = ref({
    host: '',
    port: 993,
    secure: true,
    username: '',
    password: '',
    mailbox: 'INBOX',
    initial_days: 30 as number | null,
    is_active: true,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;

function applyAccount(data: any) {
    account.value = data?.account ?? null;
    secretConfigured.value = data?.secret_configured !== false;
    allowedDomains.value = data?.defaults?.allowed_domains ?? [];
    const src = data?.account ?? data?.defaults ?? {};
    form.value.host = src.host ?? '';
    form.value.port = Number(src.port ?? 993);
    form.value.secure = src.secure !== false;
    form.value.username = data?.account?.username ?? '';
    form.value.mailbox = src.mailbox ?? 'INBOX';
    form.value.initial_days = src.initial_days ?? 30;
    form.value.is_active = data?.account ? data.account.is_active !== false : true;
    form.value.password = '';
    savedSnapshot.value = snapshot();
    managePolling();
}

function snapshot(): string {
    const { password: _pw, ...rest } = form.value;
    return JSON.stringify(rest);
}

const hasUnsaved = computed(() => !!form.value.password || (!!account.value && snapshot() !== savedSnapshot.value));

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const { data } = await api.get('/email/imap/account');
        applyAccount(data);
    } catch (e: any) {
        error.value = describe(e, 'Could not load the mailbox settings.');
    } finally {
        loading.value = false;
    }
}

async function refreshStatus() {
    try {
        const { data } = await api.get('/email/imap/account');
        account.value = data?.account ?? null;
        managePolling();
    } catch {
        /* keep the last known state */
    }
}

function managePolling() {
    const shouldPoll = !!account.value && (account.value.syncing || account.value.last_sync_status === 'running');
    if (shouldPoll && !pollTimer) pollTimer = setInterval(refreshStatus, 4000);
    if (!shouldPoll && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function describe(e: any, fallback: string): string {
    return e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? fallback;
}

function payload() {
    const p: Record<string, unknown> = {
        host: form.value.host,
        port: form.value.port,
        secure: form.value.secure,
        username: form.value.username,
        mailbox: form.value.mailbox || 'INBOX',
        initial_days: form.value.initial_days,
        is_active: form.value.is_active,
    };
    if (form.value.password) p.password = form.value.password;
    return p;
}

async function test() {
    busy.value = 'test';
    error.value = null;
    notice.value = null;
    try {
        const { data } = await api.post('/email/imap/test', payload());
        const ok = `Connection OK — ${data?.exists ?? 0} message(s) in ${form.value.mailbox || 'INBOX'}.`;
        if (!account.value || hasUnsaved.value) {
            noticeType.value = 'warning';
            notice.value = `${ok} Not saved yet — click “${account.value ? 'Save changes' : 'Connect mailbox'}” to store these credentials.`;
        } else {
            noticeType.value = 'success';
            notice.value = ok;
        }
    } catch (e: any) {
        error.value = describe(e, 'Connection failed.');
    } finally {
        busy.value = null;
    }
}

async function save() {
    busy.value = 'save';
    error.value = null;
    notice.value = null;
    try {
        const { data } = await api.put('/email/imap/account', payload());
        applyAccount(data);
        noticeType.value = 'success';
        notice.value = data?.sync === 'started'
            ? 'Saved. First sync started in the background — new mail will appear in your inbox shortly.'
            : 'Saved.';
    } catch (e: any) {
        error.value = describe(e, 'Could not save.');
    } finally {
        busy.value = null;
    }
}

async function syncNow() {
    busy.value = 'sync';
    error.value = null;
    notice.value = null;
    noticeType.value = 'success';
    try {
        const { data } = await api.post('/email/imap/sync', null, { params: { force: 1 } });
        if (data?.status === 'ok') {
            notice.value = `Synced: ${data.stored} new, ${data.skipped} already present${data.truncated ? ' (more pending — next run continues)' : ''}.`;
        } else if (data?.status === 'running') {
            notice.value = 'A sync is already running.';
        } else {
            notice.value = `Sync ${data?.status ?? 'done'}${data?.reason ? ` (${data.reason})` : ''}.`;
        }
        await refreshStatus();
    } catch (e: any) {
        error.value = describe(e, 'Sync failed.');
        await refreshStatus();
    } finally {
        busy.value = null;
    }
}

async function remove() {
    if (!window.confirm('Remove this mailbox connection? Messages already synced stay in your inbox.')) return;
    busy.value = 'remove';
    error.value = null;
    notice.value = null;
    try {
        await api.delete('/email/imap/account');
        await load();
        noticeType.value = 'success';
        notice.value = 'Mailbox connection removed.';
    } catch (e: any) {
        error.value = describe(e, 'Could not remove.');
    } finally {
        busy.value = null;
    }
}

function onSecureToggle(value: boolean) {
    form.value.secure = value;
    if (value && form.value.port === 143) form.value.port = 993;
    if (!value && form.value.port === 993) form.value.port = 143;
}

const canSave = computed(() =>
    !!form.value.host && !!form.value.username && (!!form.value.password || !!account.value?.has_password),
);

const lastSyncLabel = computed(() => {
    const at = account.value?.last_sync_at;
    if (!at) return 'never';
    const d = new Date(at);
    return isNaN(d.getTime()) ? at : d.toLocaleString();
});

const statusIcon = computed(() => {
    const s = account.value?.last_sync_status;
    if (account.value?.syncing || s === 'running') return 'sync';
    if (s === 'ok') return 'check_circle';
    if (s === 'error') return 'error';
    return 'schedule';
});

function beforeUnload(e: BeforeUnloadEvent) {
    if (!hasUnsaved.value) return;
    e.preventDefault();
    e.returnValue = '';
}

onBeforeRouteLeave(() => {
    if (!hasUnsaved.value) return true;
    return window.confirm('Your mailbox settings are not saved. Leave without saving?');
});

onMounted(() => { window.addEventListener('beforeunload', beforeUnload); load(); });
onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', beforeUnload);
    if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
    <div class="imap-settings">
        <v-progress-circular v-if="loading" indeterminate />

        <template v-else>
            <v-notice v-if="!secretConfigured" type="danger">
                IMAP is not configured on this server (missing <code>EMAIL_IMAP_SECRET</code>). Ask an administrator.
            </v-notice>
            <v-notice v-if="error" type="danger">{{ error }}</v-notice>
            <v-notice v-if="notice" :type="noticeType">{{ notice }}</v-notice>
            <v-notice v-if="!account && secretConfigured" type="warning">
                No mailbox connected for your account yet. Credentials are stored only when you click
                <strong>Connect mailbox</strong> — <em>Test connection</em> does not save anything.
            </v-notice>

            <section v-if="account" class="status">
                <div class="status-row">
                    <v-icon :name="statusIcon" :class="['status-icon', account.last_sync_status]" />
                    <div class="status-text">
                        <div class="status-title">
                            <strong>{{ account.username }}</strong>
                            <span class="muted"> on {{ account.host }}:{{ account.port }} · {{ account.mailbox }}</span>
                            <v-chip v-if="!account.is_active" small class="chip">paused</v-chip>
                        </div>
                        <div class="muted">
                            Last sync: {{ lastSyncLabel }}
                            <span v-if="account.syncing || account.last_sync_status === 'running'"> · syncing…</span>
                            <span v-else> · {{ account.last_sync_status }}</span>
                            <span v-if="account.last_uid"> · cursor UID {{ account.last_uid }}</span>
                        </div>
                        <div v-if="account.last_error" class="status-error">{{ account.last_error }}</div>
                    </div>
                    <v-button small secondary :loading="busy === 'sync'" :disabled="!!busy || !account.is_active" @click="syncNow">
                        <v-icon name="sync" left small /> Sync now
                    </v-button>
                </div>
            </section>

            <section class="form">
                <p class="intro">
                    Connect your own mailbox. New messages are copied into your Directus inbox automatically;
                    your mailbox is only ever read, never changed. The password is stored encrypted and is
                    never shown again.
                </p>

                <div class="grid">
                    <div class="field span-2">
                        <label>IMAP server</label>
                        <v-input v-model="form.host" placeholder="mail.example.com" :disabled="!!busy" />
                    </div>
                    <div class="field">
                        <label>Port</label>
                        <v-input v-model="form.port" type="number" :min="1" :max="65535" :disabled="!!busy" />
                    </div>
                    <div class="field">
                        <label>Encryption</label>
                        <v-checkbox :model-value="form.secure" label="TLS (port 993)" :disabled="!!busy" @update:model-value="onSecureToggle" />
                        <div class="hint">Off = STARTTLS on port 143.</div>
                    </div>

                    <div class="field span-2">
                        <label>Mailbox address (username)</label>
                        <v-input v-model="form.username" placeholder="you@example.com" :disabled="!!busy" />
                        <div v-if="allowedDomains.length" class="hint">Allowed: {{ allowedDomains.map(d => '@' + d).join(', ') }}</div>
                    </div>
                    <div class="field span-2">
                        <label>Password</label>
                        <v-input
                            v-model="form.password"
                            type="password"
                            autocomplete="new-password"
                            :placeholder="account?.has_password ? '•••••••• (unchanged)' : ''"
                            :disabled="!!busy"
                        />
                    </div>

                    <div class="field">
                        <label>Folder</label>
                        <v-input v-model="form.mailbox" placeholder="INBOX" :disabled="!!busy" />
                    </div>
                    <div class="field">
                        <label>Import history (days)</label>
                        <v-input v-model="form.initial_days" type="number" :min="1" :max="3650" :disabled="!!busy" />
                        <div class="hint">Applies to the first sync only.</div>
                    </div>
                    <div class="field span-2">
                        <v-checkbox v-model="form.is_active" label="Keep this mailbox in sync" :disabled="!!busy" />
                    </div>
                </div>

                <div class="actions">
                    <v-button secondary :loading="busy === 'test'" :disabled="!!busy || !secretConfigured || !form.host || !form.username" @click="test">
                        Test connection
                    </v-button>
                    <v-button :loading="busy === 'save'" :disabled="!!busy || !secretConfigured || !canSave" @click="save">
                        {{ account ? 'Save changes' : 'Connect mailbox' }}
                    </v-button>
                    <v-button v-if="account" kind="danger" secondary :loading="busy === 'remove'" :disabled="!!busy" @click="remove">
                        Remove
                    </v-button>
                </div>
            </section>
        </template>
    </div>
</template>

<style scoped>
.imap-settings { padding: 16px 24px 32px; max-width: 880px; }
.status { border: var(--theme--border-width) solid var(--theme--border-color-subdued); border-radius: var(--theme--border-radius); padding: 12px 16px; margin-bottom: 20px; background: var(--theme--background-subdued); }
.status-row { display: flex; align-items: center; gap: 14px; }
.status-text { flex: 1; min-width: 0; }
.status-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.status-icon { --v-icon-color: var(--theme--foreground-subdued); }
.status-icon.ok { --v-icon-color: var(--theme--success); }
.status-icon.error { --v-icon-color: var(--theme--danger); }
.status-icon.running { --v-icon-color: var(--theme--primary); animation: spin 1.5s linear infinite; }
.status-error { color: var(--theme--danger); margin-top: 4px; word-break: break-word; }
.muted { color: var(--theme--foreground-subdued); }
.chip { margin-left: 6px; }
.intro { color: var(--theme--foreground-subdued); margin: 0 0 16px; max-width: 70ch; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 20px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-weight: 600; }
.span-2 { grid-column: span 2; }
.hint { font-size: 12px; color: var(--theme--foreground-subdued); }
.actions { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
@media (max-width: 720px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
