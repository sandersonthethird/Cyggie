import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Part 1 (Slack meeting-notes context) — direct coverage for the
// cyggie_get_context tool. The tool is a thin wrapper over the in-product
// chat's buildCompanyContextForChat / buildContactContextForChat builders,
// so these tests focus on the wrapper's own behavior: arg validation,
// NOT_FOUND mapping, user scoping, and parity (the block carries the same
// Notes/Summary/Transcript sections the detail-page chat produces).

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { cyggieGetContext } = await import('../src/mcp/tools/get-context')
const { isToolError } = await import('../src/shared/error-envelope')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-getctx-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(() => cleanup.cleanup())

async function setupUser(): Promise<string> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  return userId
}

async function insertCompany(userId: string, canonicalName: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName,
    normalizedName: canonicalName.toLowerCase().trim(),
    status: 'active',
    entityType: 'unknown',
    classificationSource: 'manual',
    lamport: '1',
    createdByUserId: userId,
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

async function insertMeeting(
  userId: string,
  opts: { title?: string; notes?: string; summary?: string; transcriptSegments?: unknown } = {},
): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: opts.title ?? 'Test Meeting',
    date: new Date('2026-05-22T15:00:00Z'),
    status: 'scheduled',
    lamport: '1',
    createdByUserId: userId,
    notes: opts.notes ?? null,
    summary: opts.summary ?? null,
    ...(opts.transcriptSegments !== undefined
      ? { transcriptSegments: opts.transcriptSegments as never }
      : {}),
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function linkMeetingToCompany(meetingId: string, companyId: string): Promise<void> {
  await db.insert(schema.meetingCompanyLinks).values({
    meetingId,
    companyId,
    confidence: 1.0,
    linkedBy: 'manual',
  })
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
  cleanup.track(schema.contacts, schema.contacts.id, id)
  return id
}

async function linkContactToMeeting(meetingId: string, contactId: string): Promise<void> {
  await db.insert(schema.meetingSpeakerContactLinks).values({
    meetingId,
    speakerIndex: 0,
    contactId,
  })
}

describe('cyggie_get_context — argument validation', () => {
  test('both companyId and contactId → INVALID_INPUT', async () => {
    const userId = await setupUser()
    const res = await cyggieGetContext({ db, userId, companyId: 'a', contactId: 'b' })
    expect(isToolError(res)).toBe(true)
    if (isToolError(res)) expect(res.error.code).toBe('INVALID_INPUT')
  })

  test('neither id → INVALID_INPUT', async () => {
    const userId = await setupUser()
    const res = await cyggieGetContext({ db, userId })
    expect(isToolError(res)).toBe(true)
    if (isToolError(res)) expect(res.error.code).toBe('INVALID_INPUT')
  })
})

describe('cyggie_get_context — NOT_FOUND', () => {
  test('bogus companyId → NOT_FOUND', async () => {
    const userId = await setupUser()
    const res = await cyggieGetContext({ db, userId, companyId: 'co-does-not-exist' })
    expect(isToolError(res)).toBe(true)
    if (isToolError(res)) expect(res.error.code).toBe('NOT_FOUND')
  })

  test('bogus contactId → NOT_FOUND', async () => {
    const userId = await setupUser()
    const res = await cyggieGetContext({ db, userId, contactId: 'ct-does-not-exist' })
    expect(isToolError(res)).toBe(true)
    if (isToolError(res)) expect(res.error.code).toBe('NOT_FOUND')
  })

  test("another user's company → NOT_FOUND (scoping)", async () => {
    const owner = await setupUser()
    const attacker = await setupUser()
    const cid = await insertCompany(owner, 'Private Co')
    const res = await cyggieGetContext({ db, userId: attacker, companyId: cid })
    expect(isToolError(res)).toBe(true)
    if (isToolError(res)) expect(res.error.code).toBe('NOT_FOUND')
  })
})

describe('cyggie_get_context — parity with detail-page chat', () => {
  test('company block carries Notes/Summary/Transcript + cyggie link + loadedFocus', async () => {
    const userId = await setupUser()
    const cid = await insertCompany(userId, 'Parity Co')
    const mid = await insertMeeting(userId, {
      title: 'Parity sync',
      notes: 'shared notes',
      summary: 'shared summary',
      transcriptSegments: [{ speaker: 1, text: 'shared transcript line', startTime: 0, endTime: 1 }],
    })
    await linkMeetingToCompany(mid, cid)

    let loaded: { entityType: string; entityId: string } | undefined
    const res = await cyggieGetContext({
      db,
      userId,
      companyId: cid,
      onLoadedFocus: (f) => {
        loaded = f
      },
    })
    expect(isToolError(res)).toBe(false)
    if (!isToolError(res)) {
      expect(res.result).toContain('COMPANY: Parity Co')
      expect(res.result).toContain('Notes:\nshared notes')
      expect(res.result).toContain('Summary:\nshared summary')
      expect(res.result).toContain('Transcript:')
      expect(res.cyggieUrl).toContain(cid)
    }
    expect(loaded).toEqual({ entityType: 'company', entityId: cid })
  })

  test('contact block carries linked-meeting content + loadedFocus', async () => {
    const userId = await setupUser()
    const contactId = await insertContact(userId, 'Parity Founder')
    const mid = await insertMeeting(userId, {
      title: 'Founder sync',
      summary: 'Discussed roadmap.',
    })
    await linkContactToMeeting(mid, contactId)

    let loaded: { entityType: string; entityId: string } | undefined
    const res = await cyggieGetContext({
      db,
      userId,
      contactId,
      onLoadedFocus: (f) => {
        loaded = f
      },
    })
    expect(isToolError(res)).toBe(false)
    if (!isToolError(res)) {
      expect(res.result).toContain('CONTACT: Parity Founder')
      expect(res.result).toContain('Summary:\nDiscussed roadmap.')
      expect(res.cyggieUrl).toContain(contactId)
    }
    expect(loaded).toEqual({ entityType: 'contact', entityId: contactId })
  })
})
