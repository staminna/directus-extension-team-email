-- 2026-09-22 — per-user IMAP mailbox sync
--
-- Adds `email_imap_accounts` (one row per Directus user: where their mailbox
-- is and an AES-256-GCM encrypted password) and allows source='imap' on
-- inbox_email. Additive and idempotent: safe to re-run.
--
-- Permissions: deliberately NONE for regular users on email_imap_accounts.
-- Every read/write goes through /email/imap/* which scopes by the
-- authenticated user in code. Admins see the collection in Data Studio; the
-- password column only ever holds ciphertext.

BEGIN;

CREATE TABLE IF NOT EXISTS public.email_imap_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner uuid NOT NULL,
    host character varying(253) NOT NULL,
    port integer DEFAULT 993 NOT NULL,
    secure boolean DEFAULT true NOT NULL,
    username character varying(320) NOT NULL,
    password_enc text NOT NULL,
    mailbox character varying(255) DEFAULT 'INBOX' NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    initial_days integer,
    uid_validity bigint,
    last_uid bigint DEFAULT 0 NOT NULL,
    last_sync_at timestamp with time zone,
    last_sync_status character varying(16) DEFAULT 'never' NOT NULL,
    last_error text,
    date_created timestamp with time zone DEFAULT now(),
    date_updated timestamp with time zone,
    user_created uuid,
    user_updated uuid,
    CONSTRAINT email_imap_accounts_pkey PRIMARY KEY (id),
    CONSTRAINT email_imap_accounts_port_check CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT email_imap_accounts_status_check CHECK (last_sync_status IN ('never', 'running', 'ok', 'error'))
);

COMMENT ON TABLE public.email_imap_accounts IS 'One IMAP mailbox per Directus user, pulled into inbox_email (source=imap). password_enc is AES-256-GCM ciphertext keyed from EMAIL_IMAP_SECRET.';
COMMENT ON COLUMN public.email_imap_accounts.password_enc IS 'Encrypted at rest. Never readable through the API; decrypted only inside the sync worker.';
COMMENT ON COLUMN public.email_imap_accounts.uid_validity IS 'IMAP UIDVALIDITY of the mailbox when last_uid was recorded. A change resets the cursor.';
COMMENT ON COLUMN public.email_imap_accounts.last_uid IS 'Highest IMAP UID already imported. 0 = never synced / reset.';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_imap_accounts_owner_key') THEN
        ALTER TABLE public.email_imap_accounts ADD CONSTRAINT email_imap_accounts_owner_key UNIQUE (owner);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_imap_accounts_owner_foreign') THEN
        ALTER TABLE public.email_imap_accounts
            ADD CONSTRAINT email_imap_accounts_owner_foreign FOREIGN KEY (owner)
            REFERENCES public.directus_users(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_imap_accounts_active ON public.email_imap_accounts USING btree (is_active, last_sync_at);

-- inbox_email: the ONLY change is widening the CHECK so source='imap' rows can be
-- inserted. No column, field metadata, preset or permission of inbox_email is
-- touched; /admin/content/inbox_email keeps working exactly as before.
ALTER TABLE public.inbox_email DROP CONSTRAINT IF EXISTS inbox_email_source_check;
ALTER TABLE public.inbox_email ADD CONSTRAINT inbox_email_source_check
    CHECK (source IN ('postmark', 'internal', 'smtp', 'imap'));

-- Directus metadata: register the collection, the owner relation, and hide the ciphertext.
INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability, sort_field)
SELECT 'email_imap_accounts', 'cloud_sync', 'Per-user IMAP mailbox (password encrypted)', false, false, 'all', NULL
WHERE NOT EXISTS (SELECT 1 FROM directus_collections WHERE collection = 'email_imap_accounts');

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
SELECT 'email_imap_accounts', 'owner', 'directus_users', NULL, NULL, 'nullify'
WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'email_imap_accounts' AND many_field = 'owner');

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, width, note, sort)
SELECT * FROM (VALUES
  ('email_imap_accounts', 'id',               'uuid',         'input',                NULL::json, NULL,   true,  true,  'full', NULL, 1),
  ('email_imap_accounts', 'owner',            NULL,           'select-dropdown-m2o',  '{"template":"{{email}}"}'::json, 'related-values', false, false, 'half', 'Directus user this mailbox belongs to', 2),
  ('email_imap_accounts', 'username',         NULL,           'input',                NULL, NULL,   false, false, 'half', 'Full mailbox address', 3),
  ('email_imap_accounts', 'host',             NULL,           'input',                NULL, NULL,   false, false, 'half', NULL, 4),
  ('email_imap_accounts', 'port',             NULL,           'input',                NULL, NULL,   false, false, 'quarter', NULL, 5),
  ('email_imap_accounts', 'secure',           'cast-boolean', 'boolean',              '{"label":"TLS"}'::json, 'boolean', false, false, 'quarter', NULL, 6),
  ('email_imap_accounts', 'mailbox',          NULL,           'input',                NULL, NULL,   false, false, 'half', NULL, 7),
  ('email_imap_accounts', 'is_active',        'cast-boolean', 'boolean',              '{"label":"Sync enabled"}'::json, 'boolean', false, false, 'half', NULL, 8),
  ('email_imap_accounts', 'password_enc',     NULL,           'input',                '{"masked":true}'::json, NULL, true,  true,  'full', 'Ciphertext only. Set through the Email module.', 9),
  ('email_imap_accounts', 'initial_days',     NULL,           'input',                NULL, NULL,   false, false, 'half', 'History window for the first sync', 10),
  ('email_imap_accounts', 'uid_validity',     NULL,           'input',                NULL, NULL,   true,  false, 'half', NULL, 11),
  ('email_imap_accounts', 'last_uid',         NULL,           'input',                NULL, NULL,   true,  false, 'half', NULL, 12),
  ('email_imap_accounts', 'last_sync_at',     NULL,           'datetime',             NULL, 'datetime', true, false, 'half', NULL, 13),
  ('email_imap_accounts', 'last_sync_status', NULL,           'input',                NULL, NULL,   true,  false, 'half', NULL, 14),
  ('email_imap_accounts', 'last_error',       NULL,           'input-multiline',      NULL, NULL,   true,  false, 'full', NULL, 15),
  ('email_imap_accounts', 'date_created',     'date-created', 'datetime',             NULL, 'datetime', true, true, 'half', NULL, 16),
  ('email_imap_accounts', 'date_updated',     'date-updated', 'datetime',             NULL, 'datetime', true, true, 'half', NULL, 17),
  ('email_imap_accounts', 'user_created',     'user-created', 'select-dropdown-m2o',  NULL, 'user', true, true, 'half', NULL, 18),
  ('email_imap_accounts', 'user_updated',     'user-updated', 'select-dropdown-m2o',  NULL, 'user', true, true, 'half', NULL, 19)
) AS v(collection, field, special, interface, options, display, readonly, hidden, width, note, sort)
WHERE NOT EXISTS (
  SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field
);

COMMIT;

-- Rollback (loses every stored mailbox credential):
--   BEGIN;
--   DELETE FROM directus_fields WHERE collection = 'email_imap_accounts';
--   DELETE FROM directus_relations WHERE many_collection = 'email_imap_accounts';
--   DELETE FROM directus_collections WHERE collection = 'email_imap_accounts';
--   DROP TABLE IF EXISTS public.email_imap_accounts;
--   -- only if no inbox_email row has source='imap':
--   ALTER TABLE public.inbox_email DROP CONSTRAINT inbox_email_source_check;
--   ALTER TABLE public.inbox_email ADD CONSTRAINT inbox_email_source_check CHECK (source IN ('postmark','internal','smtp'));
--   COMMIT;
