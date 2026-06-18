// cyggie_execute_sql — read-only SQL execution for sophisticated LLM
// queries that the structured tools can't express (slice 10).
//
// The most powerful and most dangerous MCP tool. Defense-in-depth:
//
//   1. POSTGRES ROLE (load-bearing). Connects via a dedicated read-only
//      role with explicit SELECT grants on the allowlisted CRM tables
//      and zero access to users / sessions / oauth_* / user_credentials
//      / firms / mcp_audit. Postgres enforces this — the application
//      code can't bypass it even if it tried.
//   1b. ROW-LEVEL SECURITY (Phase 4). contacts + meetings are firm-shared
//      with an is_private owner-only opt-out. The read-only role is NOT
//      the table owner, so RLS policies apply to it: every SELECT is
//      run inside a transaction that first SET LOCALs app.user_id +
//      app.firm_id (the caller's identity from the OAuth token), and the
//      policy restricts rows to `user_id = me OR (firm_id = my_firm AND
//      is_private = false)`. This closes the one leak the structured
//      tools' app-layer filter can't cover: raw SQL reading a teammate's
//      private contact/meeting. The gateway's own (owner) role bypasses
//      RLS, so normal sync/REST are unaffected.
//   2. SESSION GUARDRAILS. Every checked-out connection runs
//      statement_timeout=5s, idle_in_transaction_session_timeout=5s,
//      default_transaction_read_only=on. Configured in
//      api-gateway/src/db/readonly-pool.ts.
//   3. PRE-FLIGHT VALIDATION. Reject queries that don't start with
//      SELECT/WITH, contain `;` (multi-statement), or exceed 8KB.
//      Belt-and-suspenders against malformed input the role grants
//      would otherwise quietly reject with a confusing error.
//   4. OUTPUT CAP. Wrap as `WITH user_q AS (<query>) SELECT * FROM
//      user_q LIMIT 1000`. Per-column truncation at 4KB.
//   5. FEATURE FLAG + SCOPE. Tool only available when
//      CYGGIE_MCP_SQL_ENABLED=true AND the caller's OAuth token has
//      the `cyggie:sql` scope. Scope is enforced one level up in
//      mcp/server.ts; flag is checked here.
//   6. AUDIT. Full query text persisted in mcp_audit.input_summary
//      (untruncated, for forensics). Permission-denied errors emit a
//      Sentry capture with tag `security: sql_permission_denied`
//      since prompt-injection attempts often surface as 42501.

import type pg from 'pg'
import type { FastifyBaseLogger } from 'fastify'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import { Sentry } from '../../sentry'
import { getReadOnlyPool, getReadOnlyPoolStatus } from '../../db/readonly-pool'
import type { GatewayEnv } from '../../env'

// Output cap (rows). Wrapper SQL enforces this regardless of the user
// query's own LIMIT. The wrapped query can ask for more, but we slice
// at 1000 before returning.
const ROW_CAP = 1000

// Per-column value cap (bytes / chars; UTF-8 worst case 4x). Anything
// longer gets sliced with a [...truncated] marker so the LLM doesn't
// blow its context window on a single oversize column value.
const COLUMN_VALUE_CAP = 4_000

// Pre-flight: max raw query length (bytes/chars). Cheap DoS guard.
const QUERY_MAX_CHARS = 8_000

export interface CyggieExecuteSqlArgs {
  env: GatewayEnv
  query: string
  // Caller identity from the OAuth token — threaded into the read-only
  // transaction via SET LOCAL so RLS policies on firm-shared tables
  // (contacts/meetings) can enforce owner-aware visibility. firmId may be
  // null for a user not yet attached to a firm; the policy then only
  // matches their own rows (firm branch can never match a null/empty
  // setting), which is the correct safe default.
  viewer: { userId: string; firmId: string | null }
  log?: FastifyBaseLogger
}

export async function cyggieExecuteSql(
  args: CyggieExecuteSqlArgs,
): Promise<ToolResult> {
  const { env, log, viewer } = args
  const query = String(args.query ?? '')

  // ─── Feature flag ────────────────────────────────────────────────
  if (!env.CYGGIE_MCP_SQL_ENABLED) {
    return err(
      ERROR_CODE.TOOL_DISABLED,
      'cyggie_execute_sql is disabled in this environment.',
    )
  }
  const poolStatus = getReadOnlyPoolStatus(env)
  if (!poolStatus.configured) {
    return err(
      ERROR_CODE.TOOL_DISABLED,
      `cyggie_execute_sql is enabled but not configured: ${poolStatus.reason}`,
    )
  }

  // ─── Pre-flight validation ───────────────────────────────────────
  const validation = validateQuery(query)
  if (!validation.ok) {
    return err(ERROR_CODE.INVALID_INPUT, validation.message)
  }

  // ─── Execute ────────────────────────────────────────────────────
  const pool = getReadOnlyPool(env)
  const wrappedSql = `WITH user_q AS (${validation.trimmed}) SELECT * FROM user_q LIMIT ${ROW_CAP}`

  let client: pg.PoolClient | null = null
  let inTx = false
  try {
    client = await pool.connect()
    // Run inside a transaction so the RLS session context is scoped to
    // this one query (SET LOCAL = transaction-local; pooler-safe — a
    // recycled connection never carries another caller's identity). The
    // connection is already default_transaction_read_only=on (readonly-
    // pool.ts), so the BEGIN is read-only; set_config writes a GUC, not
    // table data, so it's permitted in a read-only transaction.
    await client.query('BEGIN')
    inTx = true
    // Parameterized — never string-interpolate identity into SQL. The
    // third arg `true` makes set_config transaction-local (= SET LOCAL).
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [
      viewer.userId,
    ])
    await client.query(`SELECT set_config('app.firm_id', $1, true)`, [
      viewer.firmId ?? '',
    ])
    const result = await client.query(wrappedSql)
    await client.query('COMMIT')
    inTx = false
    const rows = result.rows ?? []
    const truncated = rows.map((row: Record<string, unknown>) =>
      capRowColumns(row),
    )
    const text = renderRowsAsMarkdownTable(truncated, result.fields, rows.length)
    return ok(text)
  } catch (raw) {
    if (client && inTx) {
      // Best-effort rollback; ignore secondary errors (the original is
      // what we surface). A failed ROLLBACK marks the connection bad and
      // pg.Pool discards it on release.
      await client.query('ROLLBACK').catch(() => {})
    }
    return mapPgErrorToEnvelope(raw, query, log)
  } finally {
    if (client) client.release()
  }
}

// ─── Pre-flight ──────────────────────────────────────────────────────

export interface ValidationResult {
  ok: true
  trimmed: string
}
export interface ValidationFail {
  ok: false
  message: string
}

export function validateQuery(query: string): ValidationResult | ValidationFail {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: 'Query is empty.' }
  }
  if (trimmed.length > QUERY_MAX_CHARS) {
    return {
      ok: false,
      message: `Query exceeds ${QUERY_MAX_CHARS} chars (was ${trimmed.length}).`,
    }
  }
  // Strip standard SQL comments (-- to EOL, /* */ multiline) before
  // checking for ;  — defends against `SELECT 1; /* comment */ DROP ...`
  // where the ; is in a comment and the second statement looks legit.
  const stripped = stripSqlComments(trimmed)
  if (stripped.includes(';')) {
    return {
      ok: false,
      message:
        'Multi-statement queries are not allowed (the `;` separator is forbidden).',
    }
  }
  // Must start with SELECT or WITH (caseless). UPDATE/INSERT/DELETE/
  // DROP/CREATE/etc. all rejected. Postgres's read-only transaction
  // mode would catch this too, but failing early gives a clearer
  // INVALID_INPUT envelope.
  const head = stripped.replace(/^\s*/, '').slice(0, 7).toUpperCase()
  if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
    return {
      ok: false,
      message: 'Query must start with SELECT or WITH. Other statement types are rejected.',
    }
  }
  return { ok: true, trimmed }
}

// Remove -- single-line and /* */ multi-line SQL comments. Naive — does
// not handle the corner case of comment chars inside string literals
// (e.g. `SELECT 'a; b'`), but it doesn't have to: the wrapper around
// the user query is read-only and the worst case for the corner is
// over-rejection, not under-rejection.
function stripSqlComments(s: string): string {
  return s
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

// ─── Postgres error mapping ──────────────────────────────────────────

interface PgErrorLike {
  code?: string
  message?: string
  detail?: string
  hint?: string
}

function isPgError(e: unknown): e is PgErrorLike {
  return typeof e === 'object' && e !== null && 'code' in e
}

export function mapPgErrorToEnvelope(
  raw: unknown,
  originalQuery: string,
  log?: FastifyBaseLogger,
): ToolResult {
  // pg-pool's "no connection available within timeout" error has no
  // `code` field — distinct from a pg.DatabaseError. Detect it by
  // message shape BEFORE the isPgError check so the right envelope
  // surfaces. False positives here are rare (pg errors with "timeout"
  // in the text are covered by 57014/57P05 below anyway).
  if (
    raw &&
    typeof raw === 'object' &&
    'message' in raw &&
    typeof (raw as { message: unknown }).message === 'string' &&
    /timeout/i.test((raw as { message: string }).message) &&
    !('code' in raw)
  ) {
    return err(
      ERROR_CODE.INTERNAL,
      'Cyggie is busy and could not get a database connection. Please retry in a moment.',
    )
  }
  if (!isPgError(raw)) {
    log?.error({ err: raw }, 'cyggie_execute_sql: non-pg error')
    Sentry.captureException(raw, { tags: { mcp_tool: 'cyggie_execute_sql' } })
    return err(ERROR_CODE.INTERNAL, 'Unexpected error executing query.')
  }
  const code = raw.code ?? ''
  const detail = raw.detail ? ` (${raw.detail})` : ''
  switch (code) {
    case '57014': // statement_timeout
    case '57P05': // idle_in_transaction_session_timeout
      return err(
        ERROR_CODE.TIMEOUT,
        'Query exceeded the 5s timeout. Try adding LIMIT, narrowing the WHERE clause, or asking the user to break the question into smaller parts.',
      )
    case '42501': {
      // insufficient_privilege — most-likely signal that the LLM
      // attempted a non-allowlisted table. Log + Sentry-alert as a
      // potential prompt-injection signal.
      log?.warn(
        {
          metric: 'oauth.security.sql_permission_denied',
          query_preview: originalQuery.slice(0, 200),
        },
        'cyggie_execute_sql: permission denied on protected table',
      )
      Sentry.captureMessage(
        'cyggie_execute_sql permission denied (possible prompt injection)',
        {
          tags: { security: 'sql_permission_denied' },
          level: 'warning',
          extra: { query: originalQuery.slice(0, 1000) },
        },
      )
      return err(
        ERROR_CODE.PERMISSION_DENIED,
        `Permission denied${detail}. Allowed tables: org_companies, org_company_aliases, org_company_contacts, company_investors, contacts, contact_emails, meetings, meeting_company_links, meeting_speaker_contact_links, notes, themes, note_folders, company_flagged_files, custom_field_defs, custom_field_values, deals, tasks.`,
      )
    }
    case '42P01': // undefined_table
      return err(
        ERROR_CODE.PERMISSION_DENIED,
        `Table not in allowed list${detail}.`,
      )
    case '42601': // syntax_error
      return err(
        ERROR_CODE.INVALID_INPUT,
        `SQL syntax error${detail}: ${raw.message ?? 'unknown'}`,
      )
    case '25006': // read_only_sql_transaction
      return err(
        ERROR_CODE.PERMISSION_DENIED,
        'Write statements are not allowed (read-only transaction).',
      )
    default:
      // pg.Pool timeout has no code — message check.
      if (typeof raw.message === 'string' && /timeout/i.test(raw.message)) {
        return err(
          ERROR_CODE.INTERNAL,
          'Cyggie is busy and could not get a database connection. Please retry in a moment.',
        )
      }
      log?.error(
        { err: raw, code, query_preview: originalQuery.slice(0, 200) },
        'cyggie_execute_sql: unmapped pg error',
      )
      Sentry.captureException(raw, {
        tags: { mcp_tool: 'cyggie_execute_sql', pg_code: code },
        extra: { query: originalQuery.slice(0, 1000) },
      })
      return err(
        ERROR_CODE.INTERNAL,
        `Database error${detail}: ${raw.message ?? 'unknown'} (code ${code}).`,
      )
  }
}

// ─── Output formatting ───────────────────────────────────────────────

function capRowColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.length > COLUMN_VALUE_CAP) {
      out[k] = v.slice(0, COLUMN_VALUE_CAP) + '\n[...truncated]'
    } else {
      out[k] = v
    }
  }
  return out
}

// Render rows as a markdown table. Empty result → "(no rows)". The LLM
// reads this directly; tables work well for the eyeballs-on debugging
// case and are typically the right shape for SELECT output.
function renderRowsAsMarkdownTable(
  rows: Array<Record<string, unknown>>,
  fields: pg.FieldDef[] | undefined,
  rawRowCount: number,
): string {
  if (rows.length === 0) {
    return '(no rows)'
  }
  const columns = fields?.map((f) => f.name) ?? Object.keys(rows[0])
  const header = `| ${columns.join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows
    .map((row) =>
      '| ' +
      columns
        .map((c) => formatCell(row[c]))
        .join(' | ') +
      ' |',
    )
    .join('\n')
  const cappedNote =
    rawRowCount >= ROW_CAP
      ? `\n\n_Capped at ${ROW_CAP} rows. Use a tighter WHERE clause or LIMIT for fewer._`
      : ''
  return `${header}\n${divider}\n${body}${cappedNote}`
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') {
    // Pipes break markdown tables; escape them.
    return v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, COLUMN_VALUE_CAP)
    } catch {
      return '[unserializable]'
    }
  }
  return String(v)
}
