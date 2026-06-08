-- email_sync — lean Postgres projection of the desktop email tables so the
-- gateway chat context (mobile / web) can include tagged-email correspondence
-- at parity with the desktop-local chat. See packages/db/src/schema/email.ts.
--
-- Synced via OWNED_TABLES (email_messages, email_company_links,
-- email_contact_links). body_text arrives truncated (~4 KB) from the desktop
-- backfill — raw bodies never leave the device. Created additively with
-- IF NOT EXISTS so re-running / db:push convergence is safe.

CREATE TABLE IF NOT EXISTS email_messages (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id text,
  direction varchar(16) NOT NULL,
  subject text,
  from_name text,
  from_email text NOT NULL,
  snippet text,
  body_text text,
  sent_at timestamptz,
  received_at timestamptz,
  labels_json text,
  is_unread integer NOT NULL DEFAULT 0,
  has_attachments integer NOT NULL DEFAULT 0,
  lamport text NOT NULL DEFAULT '0',
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_messages_user_idx ON email_messages(user_id);
CREATE INDEX IF NOT EXISTS email_messages_thread_idx ON email_messages(thread_id);

CREATE TABLE IF NOT EXISTS email_company_links (
  message_id text NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
  confidence double precision NOT NULL DEFAULT 1.0,
  linked_by varchar(32) NOT NULL DEFAULT 'auto',
  reason text,
  lamport text NOT NULL DEFAULT '0',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, company_id)
);
CREATE INDEX IF NOT EXISTS email_company_links_company_idx ON email_company_links(company_id);

CREATE TABLE IF NOT EXISTS email_contact_links (
  message_id text NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  confidence double precision NOT NULL DEFAULT 1.0,
  linked_by varchar(32) NOT NULL DEFAULT 'auto',
  lamport text NOT NULL DEFAULT '0',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, contact_id)
);
CREATE INDEX IF NOT EXISTS email_contact_links_contact_idx ON email_contact_links(contact_id);
