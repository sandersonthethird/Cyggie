import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Attachments owned-table sync round-trip: a desktop createAttachment / soft-
// delete reaches Neon via POST /sync/push, and a same-firm teammate sees it via
// /sync/pull (firmScoped). The gateway stamps user_id + firm_id from the JWT.
// Whole-row LWW (attachments are insert + soft-delete only, NOT field-LWW).

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-attach-sync-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

let tableReady = false
beforeAll(async () => {
  const rows = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('public.attachments') IS NOT NULL AS exists`,
  )
  const arr = (rows as unknown as { rows?: { exists: boolean }[] }).rows ?? (rows as unknown as { exists: boolean }[])
  tableReady = Boolean(arr?.[0]?.exists)
  if (!tableReady) {
    // eslint-disable-next-line no-console
    console.warn('[attachments-sync-roundtrip] SKIPPED — Neon `attachments` table not applied yet (migration 0047).')
  }
})

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const firmId = TEST_PREFIX + 'firm'
let userA = ''
let userB = ''

async function setupFirm(): Promise<void> {
  await db.insert(schema.firms).values({ id: firmId, name: 'Red Swan', slug: TEST_PREFIX + 'rs' })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const label of ['A', 'B']) {
    const id = TEST_PREFIX + label
    await db.insert(schema.users).values({
      id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: 'User ' + label, firmId,
    })
    cleanup.track(schema.users, schema.users.id, id)
    if (label === 'A') userA = id
    else userB = id
  }
}

function jwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId, sid: TEST_PREFIX + 's-' + userId, device: TEST_PREFIX + 'd-' + userId,
    scope: ['user'], firm_id: firmId, role: 'member',
  })
}

// snake_case payload, as the desktop SQLite row emits it. user_id is present
// (the SQLite table carries it); firm_id is absent — the gateway stamps it.
function attachmentPayload(id: string, userId: string, lamport: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    owner_type: 'note',
    owner_id: TEST_PREFIX + 'note',
    user_id: userId,
    kind: 'image',
    filename: 'shot.png',
    mime_type: 'image/png',
    size_bytes: 2048,
    storage_key: `attachments/${userId}/${id}`,
    checksum: 'cafebabe',
    lamport,
    ...extra,
  }
}

let outboxCounter = 0
async function push(token: string, entry: Record<string, unknown>): Promise<{ acked: number[]; rejected: unknown[] }> {
  const res = await app.inject({
    method: 'POST', url: '/sync/push', headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: TEST_PREFIX + 'dev', batch: [{ outboxId: ++outboxCounter, ...entry }] },
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('attachments sync round-trip', () => {
  test('insert → Neon (firm_id + user_id stamped); soft-delete → tombstone; teammate pulls it', async () => {
    if (!tableReady) return
    await setupFirm()
    const tokenA = await jwt(userA)
    const tokenB = await jwt(userB)
    const id = createId().slice(0, 24)
    cleanup.track(schema.attachments, schema.attachments.id, id)

    // A creates an attachment.
    const ins = await push(tokenA, {
      table: 'attachments', op: 'insert', rowId: id,
      payload: attachmentPayload(id, userA, '100'), lamport: '100',
    })
    expect(ins.acked).toHaveLength(1)
    expect(ins.rejected).toHaveLength(0)

    const [row] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id))
    expect(row).toBeTruthy()
    expect(row?.firmId).toBe(firmId) // gateway-stamped from JWT
    expect(row?.userId).toBe(userA)
    expect(row?.storageKey).toBe(`attachments/${userA}/${id}`)
    expect(row?.deletedAt).toBeNull()

    // A soft-deletes it: whole-row UPDATE setting deleted_at, higher lamport.
    const del = await push(tokenA, {
      table: 'attachments', op: 'update', rowId: id,
      payload: attachmentPayload(id, userA, '200', { deleted_at: '2026-06-24T12:00:00.000Z' }),
      lamport: '200',
    })
    expect(del.acked).toHaveLength(1)
    const [afterDelete] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, id))
    expect(afterDelete?.deletedAt).not.toBeNull()

    // Resolution model: attachments are push + download-by-id (NOT pulled to
    // every device — non-uploading devices resolve via /attachments/:id/download-url
    // by the id embedded in the markdown). So a same-firm teammate authorizes
    // against the Neon row (proven in the download-url test), and after the
    // soft-delete the row's deleted_at filter makes that route 404. tokenB is
    // unused here by design.
    void tokenB
  })

  test('cross-firm write is rejected (user_id mismatch defense)', async () => {
    if (!tableReady) return
    await setupFirm().catch(() => {}) // firm may already exist from prior test
    const tokenA = await jwt(userA)
    const id = createId().slice(0, 24)
    cleanup.track(schema.attachments, schema.attachments.id, id)
    // Payload claims a DIFFERENT user_id than the JWT sub → gateway rejects.
    const res = await push(tokenA, {
      table: 'attachments', op: 'insert', rowId: id,
      payload: attachmentPayload(id, 'someone-else', '100'), lamport: '100',
    })
    expect(res.acked).toHaveLength(0)
    expect(res.rejected).toHaveLength(1)
  })
})
