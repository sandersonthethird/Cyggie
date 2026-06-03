// Unit tests for cyggie_execute_sql pre-flight + pg-error mapping
// (External Agents V1 slice 10).
//
// Pure-function coverage: validateQuery rejection cases + the
// pg-error → MCP-envelope mapper. The full SQL execution path
// requires a real readonly Postgres role + Neon connection; that
// lives in the DB-dependent test suite (currently blocked on Neon
// quota) and in api-gateway/test/oauth-e2e.test.ts.

import { describe, expect, test } from 'vitest'
import {
  validateQuery,
  mapPgErrorToEnvelope,
} from '../src/mcp/tools/execute-sql'

describe('cyggie_execute_sql: validateQuery', () => {
  test('accepts a plain SELECT', () => {
    const r = validateQuery('SELECT canonical_name FROM org_companies LIMIT 5')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.trimmed).toMatch(/^SELECT/)
  })

  test('accepts a WITH ... SELECT', () => {
    const r = validateQuery(
      "WITH recent AS (SELECT id FROM meetings WHERE date > '2024-01-01') SELECT * FROM recent",
    )
    expect(r.ok).toBe(true)
  })

  test('accepts caseless SELECT / select / Select', () => {
    expect(validateQuery('select 1').ok).toBe(true)
    expect(validateQuery('Select 1').ok).toBe(true)
    expect(validateQuery('  SELECT 1  ').ok).toBe(true)
  })

  test('rejects empty query', () => {
    const r = validateQuery('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/empty/i)
  })

  test('rejects whitespace-only query', () => {
    const r = validateQuery('   \n\t  ')
    expect(r.ok).toBe(false)
  })

  test('rejects oversize query (>8000 chars)', () => {
    // Build a real >8KB query: SELECT + N union'd literals. trim()
    // doesn't collapse internal whitespace, so this stays oversize
    // after the validator's trim().
    const filler = Array.from({ length: 2000 }, (_, i) => `SELECT ${i}`).join(' UNION ')
    const r = validateQuery(filler)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/exceeds/i)
  })

  test('rejects non-SELECT/WITH starters', () => {
    expect(validateQuery('UPDATE companies SET name=$1').ok).toBe(false)
    expect(validateQuery('INSERT INTO companies VALUES (1)').ok).toBe(false)
    expect(validateQuery('DELETE FROM contacts').ok).toBe(false)
    expect(validateQuery('DROP TABLE meetings').ok).toBe(false)
    expect(validateQuery('TRUNCATE notes').ok).toBe(false)
    expect(validateQuery('CREATE TABLE foo (id int)').ok).toBe(false)
    expect(validateQuery('ALTER TABLE foo ADD COLUMN x int').ok).toBe(false)
  })

  test('rejects multi-statement (semicolon outside comment)', () => {
    const r = validateQuery('SELECT 1; DROP TABLE x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/multi-statement|`;`/i)
  })

  test('rejects multi-statement hidden behind a -- comment', () => {
    // The -- comment doesn't hide the second `;` outside it.
    const r = validateQuery('SELECT 1 -- a comment\n; DROP TABLE x')
    expect(r.ok).toBe(false)
  })

  test('rejects multi-statement hidden behind a /* */ comment', () => {
    const r = validateQuery('SELECT /* comment with ; inside */ 1; DROP x')
    expect(r.ok).toBe(false)
  })

  test('accepts a query with a `;` only inside a stripped comment', () => {
    // Edge case: the only ; is inside a comment → after stripping it's gone.
    const r = validateQuery('SELECT 1 /* harmless ; comment */')
    expect(r.ok).toBe(true)
  })
})

describe('cyggie_execute_sql: mapPgErrorToEnvelope', () => {
  test('57014 statement_timeout → TIMEOUT envelope', () => {
    const r = mapPgErrorToEnvelope({ code: '57014', message: 'canceling' }, 'SELECT 1')
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error.code).toBe('TIMEOUT')
      expect(r.error.message).toMatch(/5s/)
    }
  })

  test('57P05 idle_in_transaction_timeout → TIMEOUT envelope', () => {
    const r = mapPgErrorToEnvelope({ code: '57P05', message: 'idle' }, 'SELECT 1')
    if ('error' in r) expect(r.error.code).toBe('TIMEOUT')
  })

  test('42501 insufficient_privilege → PERMISSION_DENIED envelope', () => {
    const r = mapPgErrorToEnvelope(
      { code: '42501', message: 'permission denied for table users' },
      'SELECT * FROM users',
    )
    if ('error' in r) {
      expect(r.error.code).toBe('PERMISSION_DENIED')
      expect(r.error.message).toMatch(/allowed tables/i)
    }
  })

  test('42P01 undefined_table → PERMISSION_DENIED envelope', () => {
    const r = mapPgErrorToEnvelope(
      { code: '42P01', message: 'relation "secrets" does not exist' },
      'SELECT * FROM secrets',
    )
    if ('error' in r) expect(r.error.code).toBe('PERMISSION_DENIED')
  })

  test('42601 syntax_error → INVALID_INPUT envelope', () => {
    const r = mapPgErrorToEnvelope(
      { code: '42601', message: 'syntax error at or near "SELEKT"' },
      'SELEKT 1',
    )
    if ('error' in r) {
      expect(r.error.code).toBe('INVALID_INPUT')
      expect(r.error.message).toMatch(/syntax/i)
    }
  })

  test('25006 read_only_sql_transaction → PERMISSION_DENIED envelope', () => {
    const r = mapPgErrorToEnvelope(
      { code: '25006', message: 'cannot execute UPDATE in a read-only transaction' },
      'UPDATE x SET y = 1',
    )
    if ('error' in r) expect(r.error.code).toBe('PERMISSION_DENIED')
  })

  test('pool timeout (no code, message includes "timeout") → INTERNAL envelope', () => {
    const r = mapPgErrorToEnvelope(
      { message: 'timeout exceeded when trying to connect' },
      'SELECT 1',
    )
    if ('error' in r) {
      expect(r.error.code).toBe('INTERNAL')
      expect(r.error.message).toMatch(/busy|retry/i)
    }
  })

  test('unknown pg code → INTERNAL envelope (still envelope, not throw)', () => {
    const r = mapPgErrorToEnvelope(
      { code: '99999', message: 'something weird' },
      'SELECT 1',
    )
    if ('error' in r) expect(r.error.code).toBe('INTERNAL')
  })

  test('non-pg error → INTERNAL envelope', () => {
    const r = mapPgErrorToEnvelope('a plain string', 'SELECT 1')
    if ('error' in r) expect(r.error.code).toBe('INTERNAL')
  })
})
