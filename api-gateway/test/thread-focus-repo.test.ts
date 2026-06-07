import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Part 2 — DB round-trip coverage for the slack_thread_focus repo
// (getFocus / upsertFocus / loadFocusName) against the real Neon schema.
// The decision heuristic itself is covered by thread-focus-unit.test.ts.

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { getFocus, upsertFocus, loadFocusName } = await import('../src/slack/thread-focus')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-focus-repo-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdSessionIds: string[] = []
const createdCompanyIds: string[] = []
const createdContactIds: string[] = []

afterAll(async () => {
  // Sessions cascade-delete their slack_thread_focus rows (FK ON DELETE CASCADE).
  if (createdSessionIds.length > 0) {
    await db.delete(schema.chatSessions).where(inArray(schema.chatSessions.id, createdSessionIds))
  }
  if (createdCompanyIds.length > 0) {
    await db.delete(schema.orgCompanies).where(inArray(schema.orgCompanies.id, createdCompanyIds))
  }
  if (createdContactIds.length > 0) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
})

async function setupUser(): Promise<string> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  return userId
}

async function insertSession(userId: string): Promise<string> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId,
    contextId: id,
    contextKind: 'crm',
    contextLabel: 'Slack thread',
    title: null,
    lamport: '1',
    lastMessageAt: new Date(),
    createdByUserId: userId,
    origin: 'slack',
  })
  createdSessionIds.push(id)
  return id
}

async function insertCompany(userId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName: name,
    normalizedName: name.toLowerCase().trim(),
    status: 'active',
    entityType: 'unknown',
    classificationSource: 'manual',
    lamport: '1',
    createdByUserId: userId,
  })
  createdCompanyIds.push(id)
  return id
}

async function insertContact(userId: string, fullName: string): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId,
    fullName,
    normalizedName: fullName.toLowerCase(),
    lamport: '1',
    createdByUserId: userId,
  })
  createdContactIds.push(id)
  return id
}

describe('slack_thread_focus repo', () => {
  test('getFocus → null when no row', async () => {
    const userId = await setupUser()
    const sessionId = await insertSession(userId)
    expect(await getFocus(db, sessionId)).toBeNull()
  })

  test('upsertFocus inserts, getFocus round-trips', async () => {
    const userId = await setupUser()
    const sessionId = await insertSession(userId)
    await upsertFocus(db, { sessionId, entityType: 'company', entityId: 'co_abc' })
    const f = await getFocus(db, sessionId)
    expect(f?.entityType).toBe('company')
    expect(f?.entityId).toBe('co_abc')
    expect(f?.updatedAt).toBeInstanceOf(Date)
  })

  test('upsertFocus replaces entity + bumps updatedAt on conflict', async () => {
    const userId = await setupUser()
    const sessionId = await insertSession(userId)
    const t0 = new Date('2026-06-01T00:00:00Z')
    await upsertFocus(db, { sessionId, entityType: 'company', entityId: 'co_old', now: t0 })
    const t1 = new Date('2026-06-01T00:10:00Z')
    await upsertFocus(db, { sessionId, entityType: 'contact', entityId: 'ct_new', now: t1 })
    const f = await getFocus(db, sessionId)
    expect(f?.entityType).toBe('contact')
    expect(f?.entityId).toBe('ct_new')
    expect(f?.updatedAt.getTime()).toBe(t1.getTime())
  })

  test('loadFocusName returns the company / contact display name', async () => {
    const userId = await setupUser()
    const cid = await insertCompany(userId, 'Acme Robotics')
    const ctid = await insertContact(userId, 'Priya Rao')
    expect(await loadFocusName(db, { entityType: 'company', entityId: cid, updatedAt: new Date() }, userId))
      .toBe('Acme Robotics')
    expect(await loadFocusName(db, { entityType: 'contact', entityId: ctid, updatedAt: new Date() }, userId))
      .toBe('Priya Rao')
  })

  test('loadFocusName is user-scoped (another user → null)', async () => {
    const owner = await setupUser()
    const attacker = await setupUser()
    const cid = await insertCompany(owner, 'Private Co')
    expect(await loadFocusName(db, { entityType: 'company', entityId: cid, updatedAt: new Date() }, attacker))
      .toBeNull()
  })

  test('focus row cascade-deletes with its session', async () => {
    const userId = await setupUser()
    const sessionId = await insertSession(userId)
    await upsertFocus(db, { sessionId, entityType: 'company', entityId: 'co_x' })
    await db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, sessionId))
    createdSessionIds.splice(createdSessionIds.indexOf(sessionId), 1) // already gone
    const rows = await db
      .select()
      .from(schema.slackThreadFocus)
      .where(eq(schema.slackThreadFocus.sessionId, sessionId))
    expect(rows).toHaveLength(0)
  })
})
