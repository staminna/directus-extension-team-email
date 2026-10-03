# Per-user IMAP mailbox sync

Each Directus user can connect their own IMAP mailbox from **Email → My mailbox
(IMAP)**. New messages are copied into `inbox_email` with `source = 'imap'` and
`owner = <that user>`, so they show up in that user's Inbox only, thread with
their sent mail, and carry attachments like any other received message.

The mailbox is opened **read-only**; nothing is ever written back (no flags, no
moves, no deletes). Marking a message read in Directus does not mark it read in
the mailbox, and vice versa.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EMAIL_IMAP_SECRET` | — | **Required.** 32+ random characters. Mailbox passwords are encrypted at rest with AES-256-GCM using a key derived from this. Rotating it invalidates every stored password (users re-enter theirs) |
| `EMAIL_IMAP_DEFAULT_HOST` | — | Pre-filled server in the settings screen |
| `EMAIL_IMAP_DEFAULT_PORT` | `993` | |
| `EMAIL_IMAP_DEFAULT_SECURE` | `true` | Implicit TLS. `false` means STARTTLS on a plain port — never plaintext |
| `EMAIL_IMAP_ALLOWED_DOMAINS` | — | Comma list. A mailbox username must be an address on one of these; empty allows any |
| `EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED` | `true` | Keep on. Only relax for a self-signed server you control |
| `EMAIL_IMAP_SYNC_ENABLED` | `true` | Background cron |
| `EMAIL_IMAP_SYNC_CRON` | `*/2 * * * *` | Cron expression for the background sync |
| `EMAIL_IMAP_MIN_INTERVAL_SECONDS` | `20` | An on-demand sync sooner than this after the last one is skipped |
| `EMAIL_IMAP_MAX_PER_SYNC` | `100` | Messages per account per run; the next run continues where it stopped |
| `EMAIL_IMAP_INITIAL_DAYS` | `30` | How far back the first sync goes (users can override per account) |
| `EMAIL_IMAP_MAX_MESSAGE_BYTES` | `15728640` | Larger messages are stored envelope-only with a note in the body |
| `EMAIL_IMAP_SYNC_TIMEOUT_MS` | `120000` | Hard stop for one account's run |
| `EMAIL_ATTACHMENTS_FOLDER`, `EMAIL_MAX_ATTACHMENT_BYTES`, `STORAGE_LOCATIONS` | | Shared with the rest of the extension |

Generate a secret with `openssl rand -base64 48`.

## Schema

Apply `schema/2026-09-22_email_imap_accounts.sql` (additive, idempotent). It
creates `email_imap_accounts` and widens `inbox_email.source` to accept
`'imap'`. Nothing else about `inbox_email` changes.

**Grant users no permission on `email_imap_accounts`.** Every read and write
goes through `/email/imap/*`, which scopes by the authenticated user in code;
a policy on the collection would only widen that. Admins see the collection in
Data Studio, where the password column holds ciphertext only.

## Endpoints

| Route | Notes |
|---|---|
| `GET /email/imap/account` | The caller's mailbox settings, sync status and server defaults. Never the password |
| `PUT /email/imap/account` | Create or update. The credentials are tested with a real login **before** anything is saved; a failed login is a 422 and nothing changes. Starts a sync in the background |
| `DELETE /email/imap/account` | Forget the mailbox. Messages already synced stay |
| `POST /email/imap/test` | Try credentials without saving (password optional when one is stored) |
| `POST /email/imap/sync` | Pull new mail now. `?force=1` bypasses the interval throttle, `?wait=0` returns `202` immediately |

`503 service_unconfigured` on any of these means `EMAIL_IMAP_SECRET` is missing.

## How the sync works

- Cursor per account: `(uid_validity, last_uid)`. Each run asks the server for
  UIDs above `last_uid`, newest last, and checkpoints after every batch of 20.
  If the mailbox's `UIDVALIDITY` changes, the cursor resets and the history
  window is imported again.
- Every stored row has `provider_message_id = imap:<uidvalidity>:<uid>`; the
  existing unique index on `(source, provider_message_id, owner)` makes re-runs
  no-ops.
- A message whose `Message-ID` is already in the owner's inbox — mirrored by
  the send fan-out, or delivered through the inbound webhook — is skipped, so
  nothing appears twice.
- Threading follows `In-Reply-To` / `References` against both `inbox_email`
  and `emails`, exactly like the inbound route.
- `\Seen` on the server becomes `is_read` at import time only.
- Runs for one account never overlap (in-process lock); the cron skips an
  account that an on-demand sync is already working on.

## Runtime dependencies

`imapflow` and `postal-mime` are **not** bundled into `dist/api.js`; they are
resolved at runtime from this package's `node_modules` (see
`extension.config.js`). After pulling the source, run `npm install` in the
extension directory before building, and keep `node_modules` next to `dist/`
in the deployed extension folder.
