import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// POST /attachments/:id/download-url — firm-scoped presigned GET.
//
// HERMETIC for R2 (S3 presigner mocked, decision 3A); hits the dev Neon for the
// firm-scoped authorization query (the actual risk surface). The attachment row
// is firm-shared, so authz is firm_id == requester.firm_id — owner AND same-firm
// teammate resolve; a foreign firm 404s (never leak existence).
//
// SKIP-GUARD: until the Neon `attachments` table (migration 0047) is applied,
// the whole suite skips rather than erroring — it activates automatically once
// the migration lands.

const getSignedUrlMock = vi.fn(
  async () =>
    'https://test-account.r2.cloudflarestorage.com/attachments/signed-get?X-Amz-Signature=test',
)
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: getSignedUrlMock }))

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
process.env['R2_ACCOUNT_ID'] = 'test-account'
process.env['R2_ACCESS_KEY_ID'] = 'test-access-key'
process.env['R2_SECRET_ACCESS_KEY'] = 'test-secret-key'
process.env['R2_BUCKET'] = 'cyggie-attachments-test'
process.env['R2_ENDPOINT'] = 'https://test-account.r2.cloudflarestorage.com'
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'
if (!process.env['DEEPGRAM_WEBHOOK_SECRET'])
  process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-attach-dl-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

// Pre-flight: does the attachments table physically exist yet? Use
// information_schema (authoritative) rather than a drizzle select. If absent,
// skip the whole suite (it activates once migration 0047 is applied to Neon).
let tableReady = false
beforeAll(async () => {
  const rows = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('public.attachments') IS NOT NULL AS exists`,
  )
  // drizzle/node-postgres returns { rows: [...] }
  const arr = (rows as unknown as { rows?: { exists: boolean }[] }).rows ?? (rows as unknown as { exists: boolean }[])
  tableReady = Boolean(arr?.[0]?.exists)
  if (!tableReady) {
    // eslint-disable-next-line no-console
    console.warn('[attachments-download-url] SKIPPED — Neon `attachments` table not applied yet (migration 0047).')
  }
})

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const FIRM_A = TEST_PREFIX + 'firmA'
const FIRM_B = TEST_PREFIX + 'firmB'

async function seedFirm(firmId: string): Promise<void> {
  await db
    .insert(schema.firms)
    .values({ id: firmId, name: firmId, slug: firmId })
    .onConflictDoNothing()
  cleanup.track(schema.firms, schema.firms.id, firmId)
}

async function seedUser(firmId: string): Promise<string> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  return userId
}

async function seedAttachment(ownerUserId: string, firmId: string): Promise<string> {
  const id = createId().slice(0, 24)
  await db.insert(schema.attachments).values({
    id,
    ownerType: 'note',
    ownerId: TEST_PREFIX + 'note',
    userId: ownerUserId,
    firmId,
    kind: 'image',
    filename: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    storageKey: `attachments/${ownerUserId}/${id}`,
    checksum: 'deadbeef',
  })
  cleanup.track(schema.attachments, schema.attachments.id, id)
  return id
}

async function mintJwt(userId: string, firmId: string | null): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

function post(id: string, jwt: string) {
  return app.inject({
    method: 'POST',
    url: `/attachments/${id}/download-url`,
    headers: { authorization: `Bearer ${jwt}` },
  })
}

describe('POST /attachments/:id/download-url — firm-scoped', () => {
  test('owner (same firm) gets a presigned GET', async () => {
    if (!tableReady) return
    await seedFirm(FIRM_A)
    const owner = await seedUser(FIRM_A)
    const id = await seedAttachment(owner, FIRM_A)
    const res = await post(id, await mintJwt(owner, FIRM_A))
    expect(res.statusCode).toBe(200)
    const json = res.json() as { url: string; mimeType: string; checksum: string | null }
    expect(json.url).toContain('https://')
    expect(json.mimeType).toBe('image/png')
    expect(json.checksum).toBe('deadbeef')
  })

  test('same-firm teammate (not the uploader) can resolve it', async () => {
    if (!tableReady) return
    await seedFirm(FIRM_A)
    const owner = await seedUser(FIRM_A)
    const teammate = await seedUser(FIRM_A)
    const id = await seedAttachment(owner, FIRM_A)
    const res = await post(id, await mintJwt(teammate, FIRM_A))
    expect(res.statusCode).toBe(200)
  })

  test('foreign firm gets 404 (no existence leak)', async () => {
    if (!tableReady) return
    await seedFirm(FIRM_A)
    await seedFirm(FIRM_B)
    const owner = await seedUser(FIRM_A)
    const outsider = await seedUser(FIRM_B)
    const id = await seedAttachment(owner, FIRM_A)
    const res = await post(id, await mintJwt(outsider, FIRM_B))
    expect(res.statusCode).toBe(404)
  })

  test('unknown id gets 404', async () => {
    if (!tableReady) return
    await seedFirm(FIRM_A)
    const user = await seedUser(FIRM_A)
    const res = await post('nonexistentid01', await mintJwt(user, FIRM_A))
    expect(res.statusCode).toBe(404)
  })

  test('no firm (pre-onboarding) is rejected 403', async () => {
    if (!tableReady) return
    const user = await seedUser(FIRM_A).catch(() => TEST_PREFIX + 'nofirm')
    const res = await post('whatever01', await mintJwt(user, null))
    expect(res.statusCode).toBe(403)
  })
})
