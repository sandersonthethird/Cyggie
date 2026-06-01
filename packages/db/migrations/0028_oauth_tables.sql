-- OAuth 2.0 server tables for External Agents V1 slice 9.
--
-- Four tables back node-oidc-provider via the Drizzle adapter at
-- api-gateway/src/oauth/adapter.ts. See packages/db/src/schema/oauth.ts
-- for the per-table rationale.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  client_id text NOT NULL UNIQUE,
  client_name text,
  firm_id text REFERENCES firms(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_clients_firm_idx
  ON oauth_clients(firm_id);
CREATE INDEX IF NOT EXISTS oauth_clients_created_by_idx
  ON oauth_clients(created_by_user_id);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  account_id text REFERENCES users(id) ON DELETE CASCADE,
  client_id text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_grants_account_idx
  ON oauth_grants(account_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx
  ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_expires_idx
  ON oauth_grants(expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  account_id text REFERENCES users(id) ON DELETE CASCADE,
  client_id text,
  grant_id text,
  expires_at timestamptz,
  rotated_at timestamptz,
  rotated_to_id text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_account_idx
  ON oauth_refresh_tokens(account_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_idx
  ON oauth_refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_grant_idx
  ON oauth_refresh_tokens(grant_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx
  ON oauth_refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_revoked_idx
  ON oauth_refresh_tokens(revoked_at);

CREATE TABLE IF NOT EXISTS oauth_payloads (
  name text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz,
  uid text,
  user_code text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_payloads_name_id_idx
  ON oauth_payloads(name, id);
CREATE INDEX IF NOT EXISTS oauth_payloads_expires_idx
  ON oauth_payloads(expires_at);
CREATE INDEX IF NOT EXISTS oauth_payloads_uid_idx
  ON oauth_payloads(uid);
CREATE INDEX IF NOT EXISTS oauth_payloads_user_code_idx
  ON oauth_payloads(user_code);
