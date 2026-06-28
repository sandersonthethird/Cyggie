import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

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
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

// org_companies / contacts / meetings are firm-scoped. Phase 4 made the pull
// firm-scoped, so a single shared firm would leak rows ACROSS tests (every
// test's user is in the same firm). Give each test its OWN firm (beforeEach) so
// firm-scoped pulls stay test-isolated; all setupUser() calls within a test
// share that test's firm (so same-firm-sharing assertions work).
let TEST_FIRM_ID = TEST_PREFIX + 'firm'

beforeEach(async () => {
  TEST_FIRM_ID = TEST_PREFIX + 'firm-' + createId().slice(0, 8)
  await db.insert(schema.firms).values({
    id: TEST_FIRM_ID,
    name: 'Pull Test Firm',
    slug: TEST_FIRM_ID + '-slug',
  })
  cleanup.track(schema.firms, schema.firms.id, TEST_FIRM_ID)
})

async function setupUser(): Promise<{ userId: string; jwt: string; firmId: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId: TEST_FIRM_ID,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: TEST_FIRM_ID,
    role: 'member',
  })
  return { userId, jwt, firmId: TEST_FIRM_ID }
}

async function insertMeeting(
  userId: string,
  lamport: string,
  opts: { firmId?: string | null; isPrivate?: boolean } = {},
): Promise<string> {
  // Phase 4 — meetings are firm-shared. Default to the shared firm + not-private
  // so own-meeting callers stay visible; pass firmId:null (other firm) or
  // isPrivate:true to exercise the visibility exclusions.
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: `M-${lamport}`,
    date: new Date('2026-05-20T10:00:00Z'),
    status: 'scheduled',
    lamport,
    createdByUserId: userId,
    firmId: opts.firmId === undefined ? TEST_FIRM_ID : opts.firmId,
    isPrivate: opts.isPrivate ?? false,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
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

  test('firm-sharing — sees teammate SHARED meetings; hides private + other-firm', async () => {
    const alice = await setupUser()
    const bob = await setupUser() // same firm (TEST_FIRM_ID)
    const aliceShared = await insertMeeting(alice.userId, '7') // teammate, shared
    const alicePrivate = await insertMeeting(alice.userId, '8', { isPrivate: true }) // teammate, private
    const noFirm = await insertMeeting(alice.userId, '9', { firmId: null }) // not in any firm
    const bobOwnPrivate = await insertMeeting(bob.userId, '10', { isPrivate: true }) // own private

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${bob.jwt}` },
    })
    const body = res.json() as { meetings: Array<{ id: string }> }
    const ids = new Set(body.meetings.map((m) => m.id))
    expect(ids.has(aliceShared)).toBe(true) // teammate's shared meeting IS visible
    expect(ids.has(bobOwnPrivate)).toBe(true) // owner sees own private
    expect(ids.has(alicePrivate)).toBe(false) // teammate's private is hidden
    expect(ids.has(noFirm)).toBe(false) // not in the firm
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
      firmId: TEST_FIRM_ID,
      canonicalName: 'Acme',
      normalizedName: `acme-${companyId}`,
      lamport: '11',
      createdByUserId: userId,
    })
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

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
      firmId: TEST_FIRM_ID,
    })
    cleanup.track(schema.contacts, schema.contacts.id, contactId)

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
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, bobCompanyId)

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
    cleanup.track(schema.contacts, schema.contacts.id, bobContactId)

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
      firmId: TEST_FIRM_ID,
    })
    cleanup.track(schema.meetings, schema.meetings.id, id)
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

  // T40 — lazyTranscripts client: transcript suppressed for ALL statuses, not
  // just in-progress ones. Old clients (no param) keep getting transcripts (G3).
  test('G5: lazyTranscripts=1 → transcribed meeting transcript suppressed', async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '44', 'transcribed', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?lazyTranscripts=1',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row?.status).toBe('transcribed')
    expect(row?.transcriptSegments).toBeNull()
  })

  test('G6: lazyTranscripts=1 → summarized meeting transcript suppressed', async () => {
    const { userId, jwt } = await setupUser()
    const id = await insertMeetingWithTranscript(userId, '45', 'summarized', sampleSegments)

    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull?lazyTranscripts=1',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const body = res.json() as {
      meetings: Array<{ id: string; status: string; transcriptSegments: unknown }>
    }
    const row = body.meetings.find((m) => m.id === id)
    expect(row?.transcriptSegments).toBeNull()
  })

  test('G7: lazyTranscripts=1 does not change row count or serverLamport', async () => {
    const { userId, jwt } = await setupUser()
    await insertMeetingWithTranscript(userId, '46', 'transcribed', sampleSegments)

    const plain = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const lazy = await app.inject({
      method: 'GET',
      url: '/sync/pull?lazyTranscripts=1',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const pb = plain.json() as { meetings: unknown[]; serverLamport: string }
    const lb = lazy.json() as { meetings: unknown[]; serverLamport: string }
    expect(lb.meetings.length).toBe(pb.meetings.length)
    expect(lb.serverLamport).toBe(pb.serverLamport)
  })
})

// Desktop parity for firm-shared notes: /sync/pull now returns a teammate's
// tagged, non-private notes (read-only on the desktop) — closing the asymmetry
// where mobile saw the firm's notes but desktop saw only the caller's own.
describe('GET /sync/pull — firm-shared notes', () => {
  async function insertCompanyFor(userId: string): Promise<string> {
    const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    await db.insert(schema.orgCompanies).values({
      id,
      userId,
      firmId: TEST_FIRM_ID,
      canonicalName: 'NoteCo ' + id,
      normalizedName: 'noteco-' + id,
      lamport: '1',
      createdByUserId: userId,
    })
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
    return id
  }

  async function insertNote(opts: {
    userId: string
    lamport: string
    companyId?: string | null
    isPrivate?: boolean
  }): Promise<string> {
    const id = TEST_PREFIX + 'nt-' + createId().slice(0, 8)
    await db.insert(schema.notes).values({
      id,
      userId: opts.userId,
      content: `note ${id}`,
      companyId: opts.companyId ?? null,
      isPrivate: opts.isPrivate ?? false,
      lamport: opts.lamport,
      createdByUserId: opts.userId,
    })
    cleanup.track(schema.notes, schema.notes.id, id)
    return id
  }

  async function pulledNoteIds(jwt: string): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/sync/pull',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    return (res.json() as { notes: Array<{ id: string }> }).notes.map((n) => n.id)
  }

  test('teammate pulls a shared (tagged, non-private) note but NOT private/untagged', async () => {
    const owner = await setupUser()
    const teammate = await setupUser() // same TEST_FIRM_ID
    const companyId = await insertCompanyFor(owner.userId)

    const shared = await insertNote({ userId: owner.userId, lamport: '30', companyId })
    const priv = await insertNote({
      userId: owner.userId,
      lamport: '31',
      companyId,
      isPrivate: true,
    })
    const untagged = await insertNote({ userId: owner.userId, lamport: '32' })

    const teammateIds = await pulledNoteIds(teammate.jwt)
    expect(teammateIds).toContain(shared)
    expect(teammateIds).not.toContain(priv)
    expect(teammateIds).not.toContain(untagged)

    // The owner still pulls all three of their own.
    const ownerIds = await pulledNoteIds(owner.jwt)
    expect(ownerIds).toEqual(expect.arrayContaining([shared, priv, untagged]))
  })

  test('a different-firm user does not pull the firm1 shared note', async () => {
    const owner = await setupUser()
    const companyId = await insertCompanyFor(owner.userId)
    const shared = await insertNote({ userId: owner.userId, lamport: '40', companyId })

    // A user in a brand-new firm.
    const otherFirmId = TEST_PREFIX + 'firm2-' + createId().slice(0, 8)
    await db.insert(schema.firms).values({
      id: otherFirmId,
      name: 'Other Firm',
      slug: otherFirmId,
    })
    cleanup.track(schema.firms, schema.firms.id, otherFirmId)
    const outsiderId = TEST_PREFIX + 'u2-' + createId().slice(0, 8)
    await db.insert(schema.users).values({
      id: outsiderId,
      googleSub: 'sub-' + outsiderId,
      email: `${outsiderId}@example.com`,
      firmId: otherFirmId,
    })
    cleanup.track(schema.users, schema.users.id, outsiderId)
    const outsiderJwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
      sub: outsiderId,
      sid: TEST_PREFIX + 'sess-' + outsiderId,
      device: 'test-device',
      scope: ['user'],
      firm_id: otherFirmId,
      role: 'member',
    })

    const ids = await pulledNoteIds(outsiderJwt)
    expect(ids).not.toContain(shared)
  })
})
