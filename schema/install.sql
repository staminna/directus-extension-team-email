-- Team Email — additive schema install (PostgreSQL)
--
-- Use this on an EXISTING Directus project. It only creates things, never drops
-- them, so it is safe against a database that already holds your own
-- collections, and it can be re-run.
--
-- Do NOT use schema/snapshot.yaml for that. A Directus snapshot describes the
-- WHOLE schema, so `directus schema apply` treats every collection missing from
-- it as one to delete — on a populated project that is dozens of deletions. The
-- snapshot is for a brand-new, empty project only.
--
-- After running this, restart Directus so it picks up the new tables, then grant
-- your non-admin roles access (see the README). Nothing here grants anything.

BEGIN;

\restrict a5N9btYAtLXcqnd10uCEHCQ8IDN79QGmr98VQUNomysOftdQRW3UiNcK0PWCOxk
CREATE TABLE IF NOT EXISTS public.email_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alias character varying(255) NOT NULL,
    owner uuid,
    tenant character varying(255),
    is_active boolean DEFAULT true NOT NULL,
    note text,
    date_created timestamp with time zone DEFAULT now(),
    date_updated timestamp with time zone,
    display_name character varying(255),
    smtp_host character varying(255),
    smtp_port integer DEFAULT 587,
    smtp_username character varying(255),
    smtp_password_encrypted text,
    smtp_security character varying(255) DEFAULT 'STARTTLS'::character varying,
    can_send boolean DEFAULT true NOT NULL
);

COMMENT ON TABLE public.email_aliases IS 'Recipient address → Directus user mapping for inbound email routing.';

COMMENT ON COLUMN public.email_aliases.alias IS 'Exact match (support@example.com) or wildcard (*@example.com).';

CREATE TABLE IF NOT EXISTS public.email_templates (
    id integer NOT NULL,
    segment character varying(255) NOT NULL,
    subject character varying(255) NOT NULL,
    body text NOT NULL,
    active boolean DEFAULT true
);

CREATE SEQUENCE IF NOT EXISTS public.email_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.email_templates_id_seq OWNED BY public.email_templates.id;

CREATE TABLE IF NOT EXISTS public.emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    direction character varying(16) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    from_address character varying(320) NOT NULL,
    from_name character varying(255),
    to_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    bcc_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    reply_to character varying(320),
    subject text,
    body_html text,
    body_text text,
    message_id character varying(998),
    in_reply_to character varying(998),
    references_header text,
    thread_id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider character varying(32),
    provider_message_id character varying(255),
    error_message text,
    owner uuid,
    tenant character varying(255),
    is_internal boolean DEFAULT false NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    raw_payload jsonb,
    date_created timestamp with time zone DEFAULT now(),
    date_updated timestamp with time zone,
    sent_at timestamp with time zone,
    received_at timestamp with time zone,
    read_at timestamp with time zone,
    user_created uuid,
    user_updated uuid,
    CONSTRAINT emails_direction_check CHECK (((direction)::text = ANY ((ARRAY['sent'::character varying, 'received'::character varying, 'draft'::character varying])::text[]))),
    CONSTRAINT emails_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'queued'::character varying, 'sending'::character varying, 'sent'::character varying, 'delivered'::character varying, 'bounced'::character varying, 'failed'::character varying, 'received'::character varying])::text[])))
);

COMMENT ON TABLE public.emails IS 'All inbound and outbound email, per-user scoped via owner column.';

COMMENT ON COLUMN public.emails.thread_id IS 'Internal conversation grouping. Reused across replies via In-Reply-To/References.';

COMMENT ON COLUMN public.emails.is_internal IS 'When true, hidden from external (client) roles regardless of ownership.';

COMMENT ON COLUMN public.emails.raw_payload IS 'Full provider webhook payload for audit/replay. Strip in long-term archival if needed.';

CREATE TABLE IF NOT EXISTS public.emails_files (
    id integer NOT NULL,
    emails_id uuid,
    directus_files_id uuid
);

CREATE SEQUENCE IF NOT EXISTS public.emails_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.emails_files_id_seq OWNED BY public.emails_files.id;

CREATE TABLE IF NOT EXISTS public.inbox_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source character varying(16) NOT NULL,
    from_address character varying(320),
    from_name character varying(255),
    from_user uuid,
    to_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    reply_to character varying(320),
    subject text,
    body_html text,
    body_text text,
    message_id character varying(998),
    in_reply_to character varying(998),
    references_header text,
    thread_id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_message_id character varying(255),
    raw_payload jsonb,
    owner uuid,
    tenant character varying(255),
    is_internal boolean DEFAULT false NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    received_at timestamp with time zone,
    read_at timestamp with time zone,
    date_created timestamp with time zone DEFAULT now(),
    date_updated timestamp with time zone,
    user_created uuid,
    user_updated uuid,
    CONSTRAINT inbox_email_source_check CHECK (((source)::text = ANY ((ARRAY['postmark'::character varying, 'internal'::character varying, 'smtp'::character varying])::text[])))
);

COMMENT ON TABLE public.inbox_email IS 'Received emails, per-user scoped via owner. Sources: postmark (external) or internal (user-to-user).';

COMMENT ON COLUMN public.inbox_email.source IS 'postmark = external delivery; internal = sent by another Directus user.';

COMMENT ON COLUMN public.inbox_email.from_user IS 'Populated when source=internal; references the sender Directus user.';

COMMENT ON COLUMN public.inbox_email.thread_id IS 'Conversation grouping. Reused across replies via In-Reply-To/References. Shared with public.emails.thread_id.';

CREATE TABLE IF NOT EXISTS public.inbox_email_files (
    id integer NOT NULL,
    inbox_email_id uuid,
    directus_files_id uuid
);

CREATE SEQUENCE IF NOT EXISTS public.inbox_email_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.inbox_email_files_id_seq OWNED BY public.inbox_email_files.id;

ALTER TABLE ONLY public.email_templates ALTER COLUMN id SET DEFAULT nextval('public.email_templates_id_seq'::regclass);

ALTER TABLE ONLY public.emails_files ALTER COLUMN id SET DEFAULT nextval('public.emails_files_id_seq'::regclass);

ALTER TABLE ONLY public.inbox_email_files ALTER COLUMN id SET DEFAULT nextval('public.inbox_email_files_id_seq'::regclass);

DO $$ BEGIN
    ALTER TABLE ONLY public.email_aliases
        ADD CONSTRAINT email_aliases_alias_key UNIQUE (alias);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.email_aliases
        ADD CONSTRAINT email_aliases_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.email_templates
        ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.email_templates
        ADD CONSTRAINT email_templates_segment_unique UNIQUE (segment);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails_files
        ADD CONSTRAINT emails_files_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails
        ADD CONSTRAINT emails_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email_files
        ADD CONSTRAINT inbox_email_files_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email
        ADD CONSTRAINT inbox_email_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_aliases_alias_lower ON public.email_aliases USING btree (lower((alias)::text));

CREATE INDEX IF NOT EXISTS idx_email_aliases_owner ON public.email_aliases USING btree (owner);

CREATE INDEX IF NOT EXISTS idx_email_aliases_tenant ON public.email_aliases USING btree (tenant);

CREATE INDEX IF NOT EXISTS idx_emails_date_created ON public.emails USING btree (date_created DESC);

CREATE INDEX IF NOT EXISTS idx_emails_direction ON public.emails USING btree (direction);

CREATE INDEX IF NOT EXISTS idx_emails_files_emails ON public.emails_files USING btree (emails_id);

CREATE INDEX IF NOT EXISTS idx_emails_files_files ON public.emails_files USING btree (directus_files_id);

CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to ON public.emails USING btree (in_reply_to);

CREATE INDEX IF NOT EXISTS idx_emails_message_id ON public.emails USING btree (message_id);

CREATE INDEX IF NOT EXISTS idx_emails_owner ON public.emails USING btree (owner);

CREATE INDEX IF NOT EXISTS idx_emails_status ON public.emails USING btree (status);

CREATE INDEX IF NOT EXISTS idx_emails_tenant ON public.emails USING btree (tenant);

CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON public.emails USING btree (thread_id);

CREATE INDEX IF NOT EXISTS idx_emails_unread ON public.emails USING btree (owner) WHERE (is_read = false);

CREATE INDEX IF NOT EXISTS idx_inbox_email_date_created ON public.inbox_email USING btree (date_created DESC);

CREATE INDEX IF NOT EXISTS idx_inbox_email_files_email ON public.inbox_email_files USING btree (inbox_email_id);

CREATE INDEX IF NOT EXISTS idx_inbox_email_files_files ON public.inbox_email_files USING btree (directus_files_id);

CREATE INDEX IF NOT EXISTS idx_inbox_email_in_reply_to ON public.inbox_email USING btree (in_reply_to);

CREATE INDEX IF NOT EXISTS idx_inbox_email_message_id ON public.inbox_email USING btree (message_id);

CREATE INDEX IF NOT EXISTS idx_inbox_email_owner ON public.inbox_email USING btree (owner);

CREATE INDEX IF NOT EXISTS idx_inbox_email_source ON public.inbox_email USING btree (source);

CREATE INDEX IF NOT EXISTS idx_inbox_email_tenant ON public.inbox_email USING btree (tenant);

CREATE INDEX IF NOT EXISTS idx_inbox_email_thread_id ON public.inbox_email USING btree (thread_id);

CREATE INDEX IF NOT EXISTS idx_inbox_email_unread ON public.inbox_email USING btree (owner) WHERE (is_read = false);

CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_provider_msg ON public.emails USING btree (provider, provider_message_id) WHERE (provider_message_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbox_email_provider_msg_owner ON public.inbox_email USING btree (source, provider_message_id, owner) NULLS NOT DISTINCT WHERE (provider_message_id IS NOT NULL);

DO $$ BEGIN
    ALTER TABLE ONLY public.email_aliases
        ADD CONSTRAINT email_aliases_owner_fkey FOREIGN KEY (owner) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails_files
        ADD CONSTRAINT emails_files_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails_files
        ADD CONSTRAINT emails_files_emails_id_fkey FOREIGN KEY (emails_id) REFERENCES public.emails(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails
        ADD CONSTRAINT emails_owner_fkey FOREIGN KEY (owner) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails
        ADD CONSTRAINT emails_user_created_fkey FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.emails
        ADD CONSTRAINT emails_user_updated_fkey FOREIGN KEY (user_updated) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email_files
        ADD CONSTRAINT inbox_email_files_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email_files
        ADD CONSTRAINT inbox_email_files_inbox_email_id_fkey FOREIGN KEY (inbox_email_id) REFERENCES public.inbox_email(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email
        ADD CONSTRAINT inbox_email_from_user_fkey FOREIGN KEY (from_user) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email
        ADD CONSTRAINT inbox_email_owner_fkey FOREIGN KEY (owner) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email
        ADD CONSTRAINT inbox_email_user_created_fkey FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.inbox_email
        ADD CONSTRAINT inbox_email_user_updated_fkey FOREIGN KEY (user_updated) REFERENCES public.directus_users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL;
END $$;

\unrestrict a5N9btYAtLXcqnd10uCEHCQ8IDN79QGmr98VQUNomysOftdQRW3UiNcK0PWCOxk;


-- Directus metadata. Without these rows the tables exist but the Data Studio
-- treats them as untracked, and `directus schema snapshot` leaves them out.
-- Field-level metadata (interfaces, notes, display options) is deliberately not
-- shipped: Directus infers workable defaults from the columns, and a full
-- directus_fields dump would carry one installation's folder ids and wording.

INSERT INTO directus_collections (collection, icon, note, hidden, singleton, accountability)
SELECT * FROM (VALUES
  ('emails',            'outbox',          'Sent and received email, per-user',    false, false, 'all'),
  ('inbox_email',       'inbox',           'Received email, per-user',             false, false, 'all'),
  ('email_aliases',     'alternate_email', 'Address to user mapping',              false, false, 'all'),
  ('email_templates',   'description',     'Reusable email templates',             false, false, 'all'),
  ('emails_files',      'attach_file',     'Attachments junction for emails',      true,  false, 'all'),
  ('inbox_email_files', 'attach_file',     'Attachments junction for inbox_email', true,  false, 'all')
) AS v(collection, icon, note, hidden, singleton, accountability)
WHERE NOT EXISTS (SELECT 1 FROM directus_collections c WHERE c.collection = v.collection);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field)
SELECT * FROM (VALUES
  ('emails_files',      'emails_id',         'emails',         'attachments', 'directus_files_id'),
  ('emails_files',      'directus_files_id', 'directus_files', NULL,          'emails_id'),
  ('inbox_email_files', 'inbox_email_id',    'inbox_email',    'attachments', 'directus_files_id'),
  ('inbox_email_files', 'directus_files_id', 'directus_files', NULL,          'inbox_email_id')
) AS v(many_collection, many_field, one_collection, one_field, junction_field)
WHERE NOT EXISTS (
  SELECT 1 FROM directus_relations r
   WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field
);

-- The `attachments` alias fields have no column of their own: they exist only as
-- metadata, which is why they cannot come from the table definitions above.
INSERT INTO directus_fields (collection, field, special, interface, hidden, width)
SELECT * FROM (VALUES
  ('emails',      'attachments', 'm2m', 'files',    false, 'full'),
  ('inbox_email', 'attachments', 'm2m', 'list-m2m', false, 'full')
) AS v(collection, field, special, interface, hidden, width)
WHERE NOT EXISTS (
  SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field
);

COMMIT;
