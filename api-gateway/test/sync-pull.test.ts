import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// GET /sync/pull?since=<lamport> — mobile pulls deltas from Neon.
//
// Coverage:
//   • empty result when no meetings exist for the user
//   • since-filter: only meetings with lamport > since are returned
//   • user-scoping: meetings owned by other users are excluded
//   • ordering: rows come back ascending by lamport (BigInt-safe via numeric cast)
//   • serverLamport reflects the max lamport seen
//   • since=0 (or default) returns all rows (first-launch case)
//   • 401 when unauthenticated

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

const TEST_PREFIX = `test-pull-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdMeetingIds: string[] = []
const createdCompanyIds: string[] = []
const createdContactIds: string[] = []
const createdNoteIds: string[] = []

afterAll(async () => {
  // Delete in FK-safe order — children before parents.
  if (createdNoteIds.length > 0) {
    await db.delete(schema.notes).where(inArray(schema.notes.id, createdNoteIds))
  }
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdContactIds.length > 0) {
    // contact_emails + org_company_aliases cascade via FK, no manual cleanup.
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
  }
  if (createdCompanyIds.length > 0) {
    await db.delete(schema.orgCompanies).where(inArray(schema.orgCompanies.id, createdCompanyIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, jwt }
}

async function insertMeeting(userId: string, lamport: string): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: `M-${lamport}`,
    date: new Date('2026-05-20T10:00:00Z'),
    status: 'scheduled',
    lamport,
    createdByUserId: userId,
  })
  createdMeetingIds.push(id)
  return id
}

describe('GET /sync/pull', () => {
  test('empty result when user has no meetings', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { meetings: unknown[]; serverLamport: string }
    expect(body.meetings).toEqual([])
    expect(body.serverLamport).toBe('0')
  })

  test('since=0 default returns all rows ascending by lamport', async () => {
    const { userId, jwt } = await setupUser()
    const idA = await insertMeeting(userId, '5')
    const idB = await insertMeeting(userId, '20')
    const idC = await insertMeeting(userId, '12')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; lamport: string }>
      serverLamport: string
    }
    expect(body.meetings.map((m) => m.id)).toEqual([idA, idC, idB])
    expect(body.meetings.map((m) => m.lamport)).toEqual(['5', '12', '20'])
    expect(body.serverLamport).toBe('20')
  })

  test('since-filter excludes rows with lamport <= since', async () => {
    const { userId, jwt } = await setupUser()
    await insertMeeting(userId, '5')
    const idB = await insertMeeting(userId, '15')
    await insertMeeting(userId, '10')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=10',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; lamport: string }>
      serverLamport: string
    }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(idB)
    expect(body.serverLamport).toBe('15')
  })

  test('user-scoping — never returns other users meetings', async () => {
    const alice = await setupUser()
    const bob = await setupUser()
    await insertMeeting(alice.userId, '7')
    const bobMeetingId = await insertMeeting(bob.userId, '8')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${bob.jwt}` },
    })
    const body = res.json() as { meetings: Array<{ id: string; userId: string }> }
    expect(body.meetings).toHaveLength(1)
    expect(body.meetings[0]?.id).toBe(bobMeetingId)
    expect(body.meetings[0]?.userId).toBe(bob.userId)
  })

  test('BigInt-safe — lamport values beyond JS safe int compare numerically', async () => {
    const { userId, jwt } = await setupUser()
    // 2^53 = 9_007_199_254_740_992 — anything beyond is lossy in number form.
    // Lexicographic compare would put '9' > '10' which is wrong; we test the
    // numeric cast path by mixing widths.
    const small = await insertMeeting(userId, '9')
    const large = await insertMeeting(userId, '10000000000000000') // 10^16

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=8',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as { meetings: Array<{ id: string }>; serverLamport: string }
    expect(body.meetings.map((m) => m.id)).toEqual([small, large])
    expect(body.serverLamport).toBe('10000000000000000')
  })

  test('serverLamport stays at since when no rows match', async () => {
    const { userId, jwt } = await setupUser()
    await insertMeeting(userId, '3')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=100',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as { meetings: unknown[]; serverLamport: string }
    expect(body.meetings).toEqual([])
    expect(body.serverLamport).toBe('100')
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/sync/pull' })
    expect(res.statusCode).toBe(401)
  })

  // T14 — additional owned tables (notes already covered above; this group
  // verifies org_companies, org_company_aliases, contacts, contact_emails
  // are all returned and user-scoped via INNER JOIN for cascade-children).
  test('T14 — returns rows from every owned table for the user', async () => {
    const { userId, jwt } = await setupUser()

    // Seed one of each.
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 6)
    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'Acme',
      normalizedName: `acme-${companyId}`,
      lamport: '11',
      createdByUserId: userId,
    })
    createdCompanyIds.push(companyId)

    const aliasId = TEST_PREFIX + 'al-' + createId().slice(0, 6)
    await db.insert(schema.orgCompanyAliases).values({
      id: aliasId,
      companyId,
      aliasValue: 'Acme Corp',
      aliasType: 'name',
      lamport: '12',
    })

    const contactId = TEST_PREFIX + 'ct-' + createId().slice(0, 6)
    await db.insert(schema.contacts).values({
      id: contactId,
      userId,
      fullName: 'Alice',
      normalizedName: `alice-${contactId}`,
      lamport: '13',
      createdByUserId: userId,
    })
    createdContactIds.push(contactId)

    await db.insert(schema.contactEmails).values({
      contactId,
      email: `${contactId}@example.com`,
      isPrimary: 1,
      lamport: '14',
    })

    await insertMeeting(userId, '15')

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ lamport: string }>
      notes: unknown[]
      orgCompanies: Array<{ id: string; lamport: string }>
      orgCompanyAliases: Array<{ id: string; companyId: string }>
      contacts: Array<{ id: string; lamport: string }>
      contactEmails: Array<{ contactId: string; email: string }>
      serverLamport: string
    }

    expect(body.orgCompanies.find((c) => c.id === companyId)).toBeTruthy()
    expect(body.orgCompanyAliases.find((a) => a.id === aliasId)).toBeTruthy()
    expect(body.contacts.find((c) => c.id === contactId)).toBeTruthy()
    expect(body.contactEmails.find((e) => e.contactId === contactId)).toBeTruthy()
    expect(body.meetings).toHaveLength(1)
    expect(body.serverLamport).toBe('15')
  })

  test('T14 — cascade-child tables (aliases, contact_emails) are user-scoped via JOIN', async () => {
    const alice = await setupUser()
    const bob = await setupUser()

    // Bob has a company + alias + contact + contact_email.
    const bobCompanyId = TEST_PREFIX + 'co-' + createId().slice(0, 6)
    await db.insert(schema.orgCompanies).values({
      id: bobCompanyId,
      userId: bob.userId,
      canonicalName: 'BobCo',
      normalizedName: `bobco-${bobCompanyId}`,
      lamport: '21',
      createdByUserId: bob.userId,
    })
    createdCompanyIds.push(bobCompanyId)

    await db.insert(schema.orgCompanyAliases).values({
      id: TEST_PREFIX + 'al-' + createId().slice(0, 6),
      companyId: bobCompanyId,
      aliasValue: 'B.C.',
      aliasType: 'name',
      lamport: '22',
    })

    const bobContactId = TEST_PREFIX + 'ct-' + createId().slice(0, 6)
    await db.insert(schema.contacts).values({
      id: bobContactId,
      userId: bob.userId,
      fullName: 'BobContact',
      normalizedName: `bobcontact-${bobContactId}`,
      lamport: '23',
      createdByUserId: bob.userId,
    })
    createdContactIds.push(bobContactId)

    await db.insert(schema.contactEmails).values({
      contactId: bobContactId,
      email: `${bobContactId}@example.com`,
      isPrimary: 1,
      lamport: '24',
    })

    // Alice pulls — should see none of Bob's rows.
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${alice.jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      orgCompanies: Array<{ id: string }>
      orgCompanyAliases: Array<{ companyId: string }>
      contacts: Array<{ id: string }>
      contactEmails: Array<{ contactId: string }>
    }
    expect(body.orgCompanies.find((c) => c.id === bobCompanyId)).toBeFalsy()
    expect(body.orgCompanyAliases.find((a) => a.companyId === bobCompanyId)).toBeFalsy()
    expect(body.contacts.find((c) => c.id === bobContactId)).toBeFalsy()
    expect(body.contactEmails.find((e) => e.contactId === bobContactId)).toBeFalsy()
  })

  // 2026-05-24 — chat tables join the pull path. Mobile-sent chat
  // sessions and messages now flow to desktop's local SQLite via the
  // pull tick. Two cases mirror the T14 pattern.
  test('chat — returns sessions + messages for the user', async () => {
    const { userId, jwt } = await setupUser()

    const sessionId = TEST_PREFIX + 'sess-' + createId().slice(0, 6)
    await db.insert(schema.chatSessions).values({
      id: sessionId,
      userId,
      contextKind: 'crm',
      contextId: `ctx-${sessionId}`, // unique per test to avoid the partial-active-unique index
      contextLabel: null,
      title: 'Hello',
      lamport: '21',
      lastMessageAt: new Date(),
      createdByUserId: userId,
    })

    const msgId = TEST_PREFIX + 'msg-' + createId().slice(0, 6)
    await db.insert(schema.chatSessionMessages).values({
      id: msgId,
      sessionId,
      role: 'user',
      content: 'Hi from mobile',
      lamport: '22',
      createdByUserId: userId,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      chatSessions: Array<{ id: string; title: string | null }>
      chatSessionMessages: Array<{ id: string; sessionId: string; content: string }>
      serverLamport: string
    }
    expect(body.chatSessions.find((s) => s.id === sessionId)?.title).toBe('Hello')
    expect(body.chatSessionMessages.find((m) => m.id === msgId)?.content).toBe('Hi from mobile')

    // Cleanup — explicit because chat_sessions isn't in the test's
    // cascade-cleanup arrays.
    await db
      .delete(schema.chatSessions)
      .where(eq(schema.chatSessions.id, sessionId))
  })

  test('chat — sessions + messages are user-scoped (cross-user leak check)', async () => {
    const alice = await setupUser()
    const bob = await setupUser()

    const bobSessionId = TEST_PREFIX + 'sess-' + createId().slice(0, 6)
    await db.insert(schema.chatSessions).values({
      id: bobSessionId,
      userId: bob.userId,
      contextKind: 'crm',
      contextId: `ctx-${bobSessionId}`,
      contextLabel: null,
      title: 'Bobs private chat',
      lamport: '30',
      lastMessageAt: new Date(),
      createdByUserId: bob.userId,
    })
    const bobMsgId = TEST_PREFIX + 'msg-' + createId().slice(0, 6)
    await db.insert(schema.chatSessionMessages).values({
      id: bobMsgId,
      sessionId: bobSessionId,
      role: 'user',
      content: 'secret',
      lamport: '31',
      createdByUserId: bob.userId,
    })

    // Alice pulls — should NOT see Bob's session or message.
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${alice.jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      chatSessions: Array<{ id: string }>
      chatSessionMessages: Array<{ id: string }>
    }
    expect(body.chatSessions.find((s) => s.id === bobSessionId)).toBeFalsy()
    expect(body.chatSessionMessages.find((m) => m.id === bobMsgId)).toBeFalsy()

    // Cleanup.
    await db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, bobSessionId))
  })

  // ─────────────────────────────────────────────────────────────────────────
  // In-progress transcript suppression (G1–G4)
  //
  // Suppresses `transcript_segments` for meetings in non-terminal states so
  // the recording desktop doesn't re-download its own growing transcript
  // every 60s. See MEETING_IN_PROGRESS_STATUSES in sync.ts. The apply-side
  // COALESCE in sync-remote-apply.ts treats a null transcript_segments on
  // the wire as "preserve local".
  // ─────────────────────────────────────────────────────────────────────────

  async function insertMeetingWithTranscript(
    userId: string,
    lamport: string,
    status: string,
    segments: Array<{ speaker: number; text: string; startTime: number; endTime: number }>,
  ): Promise<string> {
    const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
    await db.insert(schema.meetings).values({
      id,
      userId,
      title: `M-${status}-${lamport}`,
      date: new Date('2026-05-20T10:00:00Z'),
      status,
      transcriptSegments: segments,
      lamport,
      createdByUserId: userId,
    })
    createdMeetingIds.push(id)
    return id
  }

  const sampleSegments = [
    { speaker: 0, text: 'hello world', startTime: 0, endTime: 1.5 },
    { speaker: 1, text: 'hi there', startTime: 1.5, endTime: 3.0 },
  ]

  test("G1: status='recording' → transcript_segments suppressed to null", async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '40', 'recording', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row).toBeDefined()
    expect(row?.status).toBe('recording')
    expect(row?.transcriptSegments).toBeNull()
  })

  test("G2: status='transcribing' → transcript_segments suppressed to null", async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '41', 'transcribing', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row?.status).toBe('transcribing')
    expect(row?.transcriptSegments).toBeNull()
  })

  test("G3: status='transcribed' → transcript_segments passes through unchanged (regression guard)", async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '42', 'transcribed', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row?.status).toBe('transcribed')
    expect(row?.transcriptSegments).toEqual(sampleSegments)
  })

  test("G4: status='error' → transcript_segments passes through (treated as terminal)", async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '43', 'error', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row?.status).toBe('error')
    expect(row?.transcriptSegments).toEqual(sampleSegments)
  })
})
