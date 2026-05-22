import { describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0015: meetings.scheduled_end_at column.
//
// Behavioral parity with migration-0014.test.ts — we don't re-apply the
// ALTER on every run (the migrator is responsible for that). These
// assertions verify the post-migration column shape via
// information_schema, so a future schema regression that drops or
// retypes the column fails loudly.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getPool } = await import('../src/db')

const env = loadEnv()
const pool = getPool(env.GATEWAY_DATABASE_URL)

describe('migration 0015: meetings.scheduled_end_at', () => {
  test('column exists with correct shape (timestamptz, nullable, no default)', async () => {
    const client = await pool.connect()
    try {
      const res = await client.query<{
        column_name: string
        data_type: string
        is_nullable: string
        column_default: string | null
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'meetings'
            AND column_name = 'scheduled_end_at'`,
      )
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0]).toMatchObject({
        column_name: 'scheduled_end_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      })
    } finally {
      client.release()
    }
  })
})
