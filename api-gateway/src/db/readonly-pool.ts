// Dedicated read-only Postgres pool for `cyggie_execute_sql` (slice 10).
//
// Separate from the gateway's main pool (api-gateway/src/db.ts) so that:
//   1. Connection limits are independent — a runaway LLM-generated
//      query can't starve mobile sync / chat traffic of connections.
//   2. The role itself has restricted GRANTs (see ROLE_GRANT_SCRIPT
//      below). Postgres enforces the table allowlist; the application
//      code in this module just enforces session-level guardrails.
//   3. We can apply per-session parameters (statement_timeout,
//      default_transaction_read_only) without polluting the main
//      pool's connections.
//
// Per the plan, max 4 concurrent connections. That cap is small for a
// reason: if the LLM is invoking SQL faster than 4-at-a-time, something
// is probably wrong (runaway prompt loop, etc.) and we'd rather pool-
// timeout the 5th call than let it pile up.

import pg from 'pg'
import type { GatewayEnv } from '../env'

// Run this in Neon's SQL editor (or via psql) ONCE to provision the
// read-only role. The role's URL goes into NEON_READONLY_URL.
//
// Why we don't run it from the application:
//   - CREATE ROLE / GRANT require admin privileges Cyggie's main
//     connection doesn't have (and shouldn't).
//   - One-time setup; codifying as runtime is wrong scope.
//
// The allowlist intentionally EXCLUDES users, sessions, oauth_*,
// user_credentials, firms, slack_user_mappings, mcp_audit. The LLM
// must not be able to enumerate users or read tokens via execute_sql.
export const ROLE_GRANT_SCRIPT = `
-- Run as a Postgres admin (Neon: project's role with the database owner).
-- Replace 'CHANGE_ME_secure_password_here' with a real secret.

CREATE ROLE cyggie_readonly WITH LOGIN PASSWORD 'CHANGE_ME_secure_password_here';
GRANT CONNECT ON DATABASE neondb TO cyggie_readonly;  -- replace neondb with your db name
GRANT USAGE ON SCHEMA public TO cyggie_readonly;

-- Explicit per-table grants (allowlist, not blocklist).
GRANT SELECT ON
  org_companies,
  org_company_aliases,
  org_company_contacts,
  company_investors,
  contacts,
  contact_emails,
  meetings,
  meeting_company_links,
  meeting_speaker_contact_links,
  notes,
  themes,
  note_folders,
  company_flagged_files,
  custom_field_defs,
  custom_field_values,
  deals,
  tasks
TO cyggie_readonly;

-- Belt-and-suspenders: revoke anything that might have been granted
-- via PUBLIC.
REVOKE ALL ON
  users,
  sessions,
  oauth_pending,
  oauth_tokens,
  oauth_clients,
  oauth_grants,
  oauth_refresh_tokens,
  oauth_payloads,
  user_credentials,
  firms,
  audit_log,
  outbox,
  sync_state
FROM cyggie_readonly;

-- Lock down future tables: by default they grant nothing to this role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM cyggie_readonly;
`.trim()

// Per-session SQL applied to every connection checked out of the
// readonly pool. These mirror plan slice 10 acceptance criteria.
const SESSION_PARAMS_SQL = [
  // Postgres kills any single statement that runs longer than 5s.
  "SET statement_timeout = '5s'",
  // No transaction can sit idle in BEGIN longer than 5s — prevents
  // the LLM from accidentally holding a row lock-ish state forever.
  "SET idle_in_transaction_session_timeout = '5s'",
  // Every transaction starts read-only. Combined with the role's
  // SELECT-only grants, this is double protection against accidental
  // writes via WITH ... INSERT chains.
  "SET default_transaction_read_only = on",
].join('; ')

let cachedPool: pg.Pool | null = null

export interface ReadOnlyPoolStatus {
  configured: boolean
  reason?: string
}

export function getReadOnlyPoolStatus(env: GatewayEnv): ReadOnlyPoolStatus {
  if (!env.NEON_READONLY_URL) {
    return {
      configured: false,
      reason:
        'NEON_READONLY_URL is unset. Set it to a Neon connection string for the cyggie_readonly role.',
    }
  }
  return { configured: true }
}

export function getReadOnlyPool(env: GatewayEnv): pg.Pool {
  if (!env.NEON_READONLY_URL) {
    throw new Error(
      'getReadOnlyPool called without NEON_READONLY_URL set. Guard with getReadOnlyPoolStatus first.',
    )
  }
  if (cachedPool) return cachedPool
  cachedPool = new pg.Pool({
    connectionString: env.NEON_READONLY_URL,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 30_000,
  })
  // Run the per-connection guard SQL on every new connection.
  cachedPool.on('connect', (client) => {
    client
      .query(SESSION_PARAMS_SQL)
      .catch((err) => {
        // If the SET commands fail, the connection is unsafe to use.
        // Drop it; pg.Pool will create a fresh one on next checkout.
        client.release(err instanceof Error ? err : new Error(String(err)))
      })
  })
  return cachedPool
}

// Test helper: clear the cached pool so a subsequent getReadOnlyPool
// call constructs a fresh one. Useful when env changes between test
// cases.
export async function _resetReadOnlyPoolForTests(): Promise<void> {
  const pool = cachedPool
  cachedPool = null
  if (pool) await pool.end().catch(() => {})
}
