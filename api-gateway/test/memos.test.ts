import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Tests for the read-only memos gateway routes:
//   GET /memos?companyId=:id
//   GET /memos/:id
// Plan §Tests — covers the non-Anthropic paths (no LLM mocking needed
// since these routes do no upstream calls).

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-memo-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdCompanyIds: string[] = []
const createdMemoIds: string[] = []
const createdVersionIds: string[] = []

afterAll(async () => {
  // Versions cascade from memos; memos cascade from companies/users.
  // Explicit deletes still safer in case test data spans manual edits.
  if (createdVersionIds.length > 0) {
    await db
      .delete(schema.investmentMemoVersions)
      .where(inArray(schema.investmentMemoVersions.id, createdVersionIds))
  }
  if (createdMemoIds.length > 0) {
    await db
      .delete(schema.investmentMemos)
      .where(inArray(schema.investmentMemos.id, createdMemoIds))
  }
  if (createdCompanyIds.length > 0) {
    await db
      .delete(schema.orgCompanies)
      .where(inArray(schema.orgCompanies.id, createdCompanyIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function insertTestUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
  })
  createdUserIds.push(id)
  return id
}

async function insertCompany(userId: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: 'TestCo ' + id,
    normalizedName: ('testco ' + id).toLowerCase(),
    status: 'active',
  })
  createdCompanyIds.push(id)
  return id
}

async function insertMemoWithVersion(opts: {
  userId: string
  companyId: string
  title?: string
  status?: string
  contentMarkdown?: string
  withVersion?: boolean
}): Promise<{ memoId: string; versionId: string | null }> {
  const memoId = TEST_PREFIX + 'm-' + createId().slice(0, 8)
  const versionNumber = opts.withVersion === false ? 0 : 1
  await db.insert(schema.investmentMemos).values({
    id: memoId,
    userId: opts.userId,
    companyId: opts.companyId,
    title: opts.title ?? 'Test Memo',
    status: opts.status ?? 'draft',
    latestVersionNumber: versionNumber,
  })
  createdMemoIds.push(memoId)

  if (opts.withVersion === false) return { memoId, versionId: null }

  const versionId = TEST_PREFIX + 'v-' + createId().slice(0, 8)
  await db.insert(schema.investmentMemoVersions).values({
    id: versionId,
    memoId,
    versionNumber: 1,
    contentMarkdown: opts.contentMarkdown ?? '# Test memo body',
  })
  createdVersionIds.push(versionId)
  return { memoId, versionId }
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

describe('GET /memos?companyId — list', () => {
  test('returns memos for the (user, company) tuple', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    await insertMemoWithVersion({
      userId,
      companyId,
      title: 'Memo One',
      contentMarkdown: '## Section\n- Bullet one\n- Bullet two',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos?companyId=${companyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { memos: Array<{ title: string; preview: string }> }
    expect(body.memos.length).toBe(1)
    expect(body.memos[0]?.title).toBe('Memo One')
    // Preview strips markdown headings + bullets
    expect(body.memos[0]?.preview).toContain('Bullet one')
    expect(body.memos[0]?.preview).not.toContain('##')
    expect(body.memos[0]?.preview).not.toContain('- ')
  })

  test('returns empty array for a company with no memos', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    const jwt = await mintJwt(userId)

    const res = await app.inject({
      method: 'GET',
      url: `/memos?companyId=${companyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ memos: [] })
  })

  test('drops orphan memo (latestVersionNumber=0 / no matching version row)', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    // One memo WITH a version, one orphan (no version)
    await insertMemoWithVersion({
      userId,
      companyId,
      title: 'With Version',
    })
    await insertMemoWithVersion({
      userId,
      companyId,
      title: 'Orphan',
      withVersion: false,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos?companyId=${companyId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { memos: Array<{ title: string }> }
    // Orphan is dropped; only With Version returned
    expect(body.memos.map((m) => m.title)).toEqual(['With Version'])
  })

  test('does NOT return another user\'s memos (ownership filter)', async () => {
    const ownerId = await insertTestUser()
    const otherUserId = await insertTestUser()
    const companyId = await insertCompany(ownerId)
    await insertMemoWithVersion({ userId: ownerId, companyId })

    const otherJwt = await mintJwt(otherUserId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos?companyId=${companyId}`,
      headers: { authorization: `Bearer ${otherJwt}` },
    })

    // Wrong-user query for the SAME companyId returns empty (zero memos
    // owned by otherUserId, regardless of who owns the company).
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ memos: [] })
  })

  test('rejects with 401 when no JWT', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos?companyId=${companyId}`,
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /memos/:id — detail', () => {
  test('returns latest version contentMarkdown', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    const { memoId } = await insertMemoWithVersion({
      userId,
      companyId,
      title: 'Detailed Memo',
      contentMarkdown: '# Hello world\n\nBody text.',
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos/${memoId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { title: string; contentMarkdown: string | null }
    expect(body.title).toBe('Detailed Memo')
    expect(body.contentMarkdown).toContain('Hello world')
  })

  test('returns 200 with null/empty contentMarkdown for orphan memo (no version row)', async () => {
    const userId = await insertTestUser()
    const companyId = await insertCompany(userId)
    const { memoId } = await insertMemoWithVersion({
      userId,
      companyId,
      title: 'Empty Memo',
      withVersion: false,
    })

    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos/${memoId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    // The detail endpoint LEFT JOINs (vs INNER JOIN on list), so the
    // memo metadata is returned even when no version row exists. Mobile
    // handles the empty contentMarkdown via its dedicated empty state.
    expect(res.statusCode).toBe(200)
    const body = res.json() as { title: string; contentMarkdown: string | null }
    expect(body.title).toBe('Empty Memo')
    expect(body.contentMarkdown).toBeNull()
  })

  test('404 for another user\'s memo (ownership filter)', async () => {
    const ownerId = await insertTestUser()
    const otherUserId = await insertTestUser()
    const companyId = await insertCompany(ownerId)
    const { memoId } = await insertMemoWithVersion({ userId: ownerId, companyId })

    const otherJwt = await mintJwt(otherUserId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos/${memoId}`,
      headers: { authorization: `Bearer ${otherJwt}` },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'MEMO_NOT_FOUND' } })
  })

  test('404 for unknown id', async () => {
    const userId = await insertTestUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'GET',
      url: `/memos/never-exists-id`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(404)
  })

  test('rejects with 401 when no JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/memos/any-id-will-do`,
    })
    expect(res.statusCode).toBe(401)
  })
})
