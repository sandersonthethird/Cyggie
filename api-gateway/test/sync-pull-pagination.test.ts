import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// L2 — /sync/pull pagination. With a tiny page size, a firm with more
// companies than the page returns them across multiple pages, gap-free, with
// hasMore set until drained.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'
process.env['SYNC_PULL_PAGE_SIZE'] = '2' // tiny page so 3 rows span 2 pages

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const P = `test-pgn-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const firmId = P + 'firm'
let token = ''

beforeAll(async () => {
  await db.insert(schema.firms).values({ id: firmId, name: 'Firm', slug: P + 'slug' })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  const userId = P + 'u'
  await db.insert(schema.users).values({
    id: userId, googleSub: 'sub-' + userId, email: `${userId}@example.com`, displayName: 'U', firmId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  // Three companies at lamports 10, 20, 30.
  for (const [n, lamport] of [['a', '10'], ['b', '20'], ['c', '30']] as const) {
    const id = P + 'co-' + n
    await db.insert(schema.orgCompanies).values({
      id, userId, firmId, canonicalName: 'Co ' + n, normalizedName: `co-${id}`, lamport,
    })
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  }
  token = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId, sid: P + 'sess', device: P + 'dev', scope: ['user'], firm_id: firmId, role: 'member',
  })
})

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
  delete process.env['SYNC_PULL_PAGE_SIZE']
})

function pull(since: string): Promise<{ orgCompanies: Array<{ id: string; lamport: string }>; serverLamport: string; hasMore: boolean }> {
  return app
    .inject({ method: 'GET', url: `/sync/pull?since=${since}`, headers: { authorization: `Bearer ${token}` } })
    .then((r) => {
      expect(r.statusCode).toBe(200)
      return r.json()
    })
}

describe('GET /sync/pull pagination', () => {
  test('drains 3 companies across pages (gap-free) with hasMore', async () => {
    // Page 1: page size 2 → first 2 companies, hasMore true, cursor at ceiling.
    const p1 = await pull('0')
    const ids1 = p1.orgCompanies.map((c) => c.id)
    expect(p1.hasMore).toBe(true)
    expect(ids1).toContain(P + 'co-a')
    expect(ids1).toContain(P + 'co-b')
    expect(ids1).not.toContain(P + 'co-c')
    expect(p1.serverLamport).toBe('20') // ceiling = min max of capped table

    // Page 2: from the ceiling → the last company, hasMore false.
    const p2 = await pull(p1.serverLamport)
    const ids2 = p2.orgCompanies.map((c) => c.id)
    expect(ids2).toEqual([P + 'co-c'])
    expect(p2.hasMore).toBe(false)

    // Union of both pages = all three, none skipped.
    expect(new Set([...ids1, ...ids2])).toEqual(
      new Set([P + 'co-a', P + 'co-b', P + 'co-c']),
    )
  })
})
