// cyggie_execute_sql — RLS session-context wiring (Phase 4).
//
// The full RLS *enforcement* (policy actually hiding a teammate's private
// contact) needs a real Postgres role + Neon connection — that lives in the
// DB-dependent suite. These tests assert the application-side contract that
// makes the policy work: every query runs inside a transaction that SET
// LOCALs the caller's app.user_id + app.firm_id (parameterized, never
// interpolated), and a failure rolls the transaction back.

import { beforeEach, describe, expect, test, vi } from 'vitest'

interface QueryCall {
  sql: string
  params?: unknown[]
}
const queryCalls: QueryCall[] = []
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown>
let released = false

vi.mock('../src/db/readonly-pool', () => ({
  getReadOnlyPoolStatus: () => ({ configured: true }),
  getReadOnlyPool: () => ({
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => {
        queryCalls.push({ sql, params })
        return queryImpl(sql, params)
      },
      release: () => {
        released = true
      },
    }),
  }),
}))

const { cyggieExecuteSql } = await import('../src/mcp/tools/execute-sql')
const { isToolError } = await import('../src/shared/error-envelope')

// Only CYGGIE_MCP_SQL_ENABLED is read directly; pool access is mocked.
const env = { CYGGIE_MCP_SQL_ENABLED: true } as never

const viewer = { userId: 'user-A', firmId: 'firm-1' }

beforeEach(() => {
  queryCalls.length = 0
  released = false
  queryImpl = async (sql: string) => {
    if (/^WITH user_q/.test(sql)) {
      return { rows: [{ id: 'c1' }], fields: [{ name: 'id' }] }
    }
    return { rows: [] }
  }
})

describe('cyggie_execute_sql: RLS session context', () => {
  test('wraps the query in a txn that SET LOCALs app.user_id + app.firm_id', async () => {
    const res = await cyggieExecuteSql({
      env,
      query: 'SELECT id FROM contacts',
      viewer,
    })
    expect(isToolError(res)).toBe(false)

    const sqls = queryCalls.map((c) => c.sql)
    // Order matters: BEGIN → set both GUCs → run query → COMMIT.
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toMatch(/set_config\('app\.user_id'/)
    expect(sqls[2]).toMatch(/set_config\('app\.firm_id'/)
    expect(sqls[3]).toMatch(/^WITH user_q AS \(SELECT id FROM contacts\)/)
    expect(sqls[4]).toBe('COMMIT')

    // Identity is parameterized, not interpolated.
    expect(queryCalls[1].params).toEqual(['user-A'])
    expect(queryCalls[2].params).toEqual(['firm-1'])
    // The set_config args carry no user value inline.
    expect(queryCalls[1].sql).not.toContain('user-A')
    expect(released).toBe(true)
  })

  test('a null firmId binds an empty string (own-rows-only, never NULL)', async () => {
    await cyggieExecuteSql({
      env,
      query: 'SELECT id FROM meetings',
      viewer: { userId: 'user-B', firmId: null },
    })
    const firmCall = queryCalls.find((c) => /app\.firm_id/.test(c.sql))
    expect(firmCall?.params).toEqual([''])
  })

  test('rolls back when the query fails, then surfaces the error envelope', async () => {
    queryImpl = async (sql: string) => {
      if (/^WITH user_q/.test(sql)) {
        throw Object.assign(new Error('syntax error'), { code: '42601' })
      }
      return { rows: [] }
    }
    const res = await cyggieExecuteSql({
      env,
      query: 'SELECT bad syntax',
      viewer,
    })
    expect(isToolError(res)).toBe(true)
    expect(queryCalls.map((c) => c.sql)).toContain('ROLLBACK')
    // Never COMMITs a failed query.
    expect(queryCalls.map((c) => c.sql)).not.toContain('COMMIT')
    expect(released).toBe(true)
  })
})
