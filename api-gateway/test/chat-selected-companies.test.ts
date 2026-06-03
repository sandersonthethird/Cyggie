import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Phase 2 (Mobile Chat) — gateway coverage for the global Ask Cyggie
// company-context picker. Covers:
//
//   PATCH /chat/sessions/:id   selectedCompanyIds optional body field
//   GET   /chat/sessions/:id   hydrates selectedCompanies via org_companies JOIN
//                              + silently filters stale (deleted) IDs
//
// Phase 2.5 additions (bottom of file): direct tests against the exported
// context builders covering the new composeMeetingContextBlock helper,
// 300K defensive cap, per-entity company-chat delegation parity, contact-
// chat enrichment, and the prompt-cache segmented system prompt.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const {
  composeMeetingContextBlock,
  buildSelectedCompaniesContext,
  buildCompanyContextForChat,
  buildContactContextForChat,
  buildChatSessionSystemSegments,
  buildContextForSession,
} = await import('../src/routes/chat')
const { stripContextIdPrefix } = await import('@cyggie/shared')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-chat-selcomp-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdSessionIds: string[] = []
const createdCompanyIds: string[] = []
const createdMeetingIds: string[] = []
const createdContactIds: string[] = []

afterAll(async () => {
  // FK-safe deletion order: meetings cascade their link rows + speaker
  // contact link rows; companies cascade their link rows; contacts
  // cascade their speaker links. Delete leaves before parents.
  if (createdSessionIds.length > 0) {
    await db
      .delete(schema.chatSessions)
      .where(inArray(schema.chatSessions.id, createdSessionIds))
  }
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdContactIds.length > 0) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, createdContactIds))
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

async function insertCompany(
  userId: string,
  canonicalName: string,
  extra: Partial<typeof schema.orgCompanies.$inferInsert> = {},
): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    canonicalName,
    normalizedName: canonicalName.toLowerCase().replace(/\s+/g, ' ').trim(),
    status: 'active',
    entityType: 'unknown',
    classificationSource: 'manual',
    lamport: '1',
    createdByUserId: userId,
    ...extra,
  })
  createdCompanyIds.push(id)
  return id
}

async function insertMeeting(
  userId: string,
  opts: {
    date?: Date
    title?: string | null
    notes?: string | null
    summary?: string | null
    transcriptSegments?: unknown
  } = {},
): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId,
    title: opts.title ?? 'Test Meeting',
    date: opts.date ?? new Date('2026-05-22T15:00:00Z'),
    status: 'scheduled',
    lamport: '1',
    createdByUserId: userId,
    notes: opts.notes ?? null,
    summary: opts.summary ?? null,
    ...(opts.transcriptSegments !== undefined
      ? { transcriptSegments: opts.transcriptSegments as never }
      : {}),
  })
  createdMeetingIds.push(id)
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

async function insertContact(
  userId: string,
  fullName: string,
  primaryCompanyId?: string,
): Promise<string> {
  const id = TEST_PREFIX + 'ct-' + createId().slice(0, 8)
  await db.insert(schema.contacts).values({
    id,
    userId,
    fullName,
    normalizedName: fullName.toLowerCase(),
    lamport: '1',
    createdByUserId: userId,
    ...(primaryCompanyId ? { primaryCompanyId } : {}),
  })
  createdContactIds.push(id)
  return id
}

async function linkContactToMeeting(
  meetingId: string,
  contactId: string,
  speakerIndex = 0,
): Promise<void> {
  await db.insert(schema.meetingSpeakerContactLinks).values({
    meetingId,
    speakerIndex,
    contactId,
  })
}

async function insertCrmSession(
  userId: string,
  selectedCompanyIds: string[] = [],
): Promise<string> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId,
    contextId: id, // unique per session for the active-idx
    contextKind: 'crm',
    contextLabel: null,
    title: null,
    lamport: '1',
    lastMessageAt: new Date(),
    createdByUserId: userId,
    selectedCompanyIds,
  })
  createdSessionIds.push(id)
  return id
}

// Per-entity session insert — mirrors what mobile's createOrGetChatSession
// produces for the meeting/company/contact detail-screen chat. The
// "<kind>:<entityId>" contextId shape is the production convention
// (see packages/shared/src/chat-context-id.ts).
async function insertEntitySession(
  userId: string,
  kind: 'meeting' | 'company' | 'contact',
  entityId: string,
): Promise<typeof schema.chatSessions.$inferSelect> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId,
    contextId: `${kind}:${entityId}`,
    contextKind: kind,
    contextLabel: null,
    title: null,
    lamport: '1',
    lastMessageAt: new Date(),
    createdByUserId: userId,
  })
  createdSessionIds.push(id)
  const rows = await db
    .select()
    .from(schema.chatSessions)
    .where(inArray(schema.chatSessions.id, [id]))
  return rows[0]!
}

// ──────────────────────────────────────────────────────────────────────────
// PATCH /chat/sessions/:id with selectedCompanyIds
// ──────────────────────────────────────────────────────────────────────────

describe('PATCH /chat/sessions/:id — selectedCompanyIds', () => {
  test('200 — sets selectedCompanyIds and bumps lamport', async () => {
    const { userId, jwt } = await setupUser()
    const c1 = await insertCompany(userId, 'Acme Co')
    const c2 = await insertCompany(userId, 'Beta Inc')
    const sessionId = await insertCrmSession(userId)

    const futureLamport = String(Date.now() + 5_000)
    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        selectedCompanyIds: [c1, c2],
        lamport: futureLamport,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      selectedCompanyIds: string[]
      lamport: string
    }
    expect(body.id).toBe(sessionId)
    expect(body.selectedCompanyIds).toEqual([c1, c2])
    expect(BigInt(body.lamport)).toBeGreaterThan(1n)
  })

  test('409 — stale lamport returns current state without applying', async () => {
    const { userId, jwt } = await setupUser()
    const c1 = await insertCompany(userId, 'Stale Co')
    const sessionId = await insertCrmSession(userId, [])

    // Bump stored lamport directly so our PATCH lamport is too low.
    const futureLamport = String(Date.now() + 1_000)
    await db
      .update(schema.chatSessions)
      .set({ lamport: futureLamport })
      .where(inArray(schema.chatSessions.id, [sessionId]))

    const staleLamport = '2'
    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { selectedCompanyIds: [c1], lamport: staleLamport },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json() as { selectedCompanyIds: string[] }
    // Pre-PATCH state: still empty.
    expect(body.selectedCompanyIds).toEqual([])
  })

  test('400 — PATCH with only lamport (no other fields) is rejected', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertCrmSession(userId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { lamport: String(Date.now() + 1_000) },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string } }
    expect(body.error.code).toBe('CHAT_SESSION_PATCH_EMPTY')
  })

  test('200 — empty array clears prior selection', async () => {
    const { userId, jwt } = await setupUser()
    const c1 = await insertCompany(userId, 'To-Clear Co')
    const sessionId = await insertCrmSession(userId, [c1])

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        selectedCompanyIds: [],
        lamport: String(Date.now() + 5_000),
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { selectedCompanyIds: string[] }
    expect(body.selectedCompanyIds).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// PATCH /chat/sessions/:id — cacheEnabled toggle
// ──────────────────────────────────────────────────────────────────────────

describe('PATCH /chat/sessions/:id — cacheEnabled', () => {
  test('200 — toggling cacheEnabled off persists and round-trips', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertCrmSession(userId)

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        cacheEnabled: false,
        lamport: String(Date.now() + 5_000),
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; cacheEnabled: boolean }
    expect(body.id).toBe(sessionId)
    expect(body.cacheEnabled).toBe(false)
  })

  test('200 — new sessions default to cacheEnabled=true', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertCrmSession(userId)

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { session: { cacheEnabled: boolean } }
    expect(body.session.cacheEnabled).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /chat/sessions/:id — selectedCompanies hydration + stale-filter
// ──────────────────────────────────────────────────────────────────────────

describe('GET /chat/sessions/:id — selectedCompanies hydration', () => {
  test('returns hydrated chips for every valid selected company', async () => {
    const { userId, jwt } = await setupUser()
    const c1 = await insertCompany(userId, 'First Co', {
      industry: 'AI',
      stage: 'Seed',
    })
    const c2 = await insertCompany(userId, 'Second Inc')
    const sessionId = await insertCrmSession(userId, [c1, c2])

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      session: { selectedCompanyIds: string[] }
      selectedCompanies: Array<{
        id: string
        name: string
        industry: string | null
        stage: string | null
      }>
    }
    // Order matches input order (deterministic pill layout).
    expect(body.selectedCompanies.map((c) => c.id)).toEqual([c1, c2])
    expect(body.selectedCompanies[0]?.name).toBe('First Co')
    expect(body.selectedCompanies[0]?.industry).toBe('AI')
    expect(body.selectedCompanies[0]?.stage).toBe('Seed')
    expect(body.selectedCompanies[1]?.name).toBe('Second Inc')
    expect(body.selectedCompanies[1]?.industry).toBeNull()
    // The raw row still carries the IDs (no auto-cleanup).
    expect(body.session.selectedCompanyIds).toEqual([c1, c2])
  })

  test('silently filters stale (deleted) company IDs out of selectedCompanies', async () => {
    const { userId, jwt } = await setupUser()
    const valid = await insertCompany(userId, 'Lives On Co')
    const sessionId = await insertCrmSession(userId, [
      valid,
      'co-deleted-' + createId(), // never existed
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      session: { selectedCompanyIds: string[] }
      selectedCompanies: Array<{ id: string }>
    }
    // Hydrated chips = valid only; stale IDs disappear from the chip list.
    expect(body.selectedCompanies.map((c) => c.id)).toEqual([valid])
    // But the raw row still carries both — they'll naturally drop on the
    // next user-driven PATCH (initialSelectedIds comes from selectedCompanies).
    expect(body.session.selectedCompanyIds).toHaveLength(2)
  })

  test('returns empty selectedCompanies for sessions with no picks', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertCrmSession(userId, [])

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { selectedCompanies: unknown[] }
    expect(body.selectedCompanies).toEqual([])
  })

  test('does not leak companies belonging to other users', async () => {
    const { userId: userA, jwt: jwtA } = await setupUser()
    const { userId: userB } = await setupUser()
    const cOfB = await insertCompany(userB, 'B-owned Co')
    // userA selects a company that belongs to userB (e.g. attacker pokes
    // an arbitrary id into selectedCompanyIds). The JOIN's user-id
    // predicate should filter it out.
    const sessionId = await insertCrmSession(userA, [cOfB])

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwtA}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { selectedCompanies: unknown[] }
    expect(body.selectedCompanies).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 2.5 — composeMeetingContextBlock branches (pure function)
// ──────────────────────────────────────────────────────────────────────────

describe('composeMeetingContextBlock — per-meeting render', () => {
  const baseDate = new Date('2026-05-22T15:00:00Z')

  test('1. summary + notes + transcript → all three sections present', () => {
    const block = composeMeetingContextBlock({
      title: 'Vitals Vault sync',
      date: baseDate,
      notes: 'Discussed peptide deal.',
      summary: 'Sync covering strategic priorities.',
      transcriptSegmentsRaw: [
        { speaker: 1, text: 'Approached by a peptide company.', startTime: 0, endTime: 5 },
      ],
    })
    expect(block).toContain('Meeting: Vitals Vault sync —')
    expect(block).toContain('Notes:\nDiscussed peptide deal.')
    expect(block).toContain('Summary:\nSync covering strategic priorities.')
    expect(block).toContain('Transcript:')
    expect(block).toContain('peptide company')
  })

  test('2. summary only → contains Summary, no Transcript', () => {
    const block = composeMeetingContextBlock({
      title: 'No transcript meeting',
      date: baseDate,
      notes: null,
      summary: 'A brief summary.',
      transcriptSegmentsRaw: null,
    })
    expect(block).toContain('Summary:')
    expect(block).not.toContain('Transcript:')
    expect(block).not.toContain('Notes:')
  })

  test('3. transcript only → contains Transcript, no Summary', () => {
    const block = composeMeetingContextBlock({
      title: 'No summary meeting',
      date: baseDate,
      notes: null,
      summary: null,
      transcriptSegmentsRaw: [
        { speaker: 1, text: 'Hello.', startTime: 0, endTime: 1 },
      ],
    })
    expect(block).toContain('Transcript:')
    expect(block).not.toContain('Summary:')
  })

  test('4. notes only → contains Notes only', () => {
    const block = composeMeetingContextBlock({
      title: 'Notes-only meeting',
      date: baseDate,
      notes: 'Just notes here.',
      summary: null,
      transcriptSegmentsRaw: null,
    })
    expect(block).toContain('Notes:\nJust notes here.')
    expect(block).not.toContain('Summary:')
    expect(block).not.toContain('Transcript:')
  })

  test('5. stub meeting (no content) → just header line', () => {
    const block = composeMeetingContextBlock({
      title: 'Empty',
      date: baseDate,
      notes: null,
      summary: null,
      transcriptSegmentsRaw: null,
    })
    expect(block).toMatch(/^Meeting: Empty — \S/)
    expect(block).not.toContain('Notes:')
    expect(block).not.toContain('Summary:')
    expect(block).not.toContain('Transcript:')
  })

  test('6. each section truncated when over its cap, with marker', () => {
    const longText = 'x'.repeat(20_000)
    const block = composeMeetingContextBlock({
      title: 'Too long',
      date: baseDate,
      notes: longText,
      summary: longText,
      transcriptSegmentsRaw: [
        { speaker: 1, text: longText, startTime: 0, endTime: 1 },
      ],
    })
    // Three '[...truncated...]' markers — one per oversized section.
    const truncMarkers = block.match(/\[\.\.\.truncated\.\.\.\]/g) ?? []
    expect(truncMarkers).toHaveLength(3)
    // Block size bounded by sum of section caps + small overhead.
    // SUMMARY (6K) + TRANSCRIPT (6K) + NOTES (2K) + headers/markers ≈ 14.5K cap.
    expect(block.length).toBeLessThan(15_000)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 2.5 — buildSelectedCompaniesContext / buildCompanyContextForChat
// ──────────────────────────────────────────────────────────────────────────

describe('buildSelectedCompaniesContext — meeting content + cap + delegation', () => {
  test('7. 300K combined cap → trailing companies silently dropped', { timeout: 30_000 }, async () => {
    const { userId } = await setupUser()
    // Make 4 companies each with one meeting whose summary is ~80K chars.
    // 4 × ~80K = ~320K which exceeds the 300K cap; expect at least one
    // company dropped from the output.
    const big = 'x'.repeat(80_000) // exceeds SUMMARY_PER_MEETING_CAP (6K) so will be truncated to 6K + marker
    // To actually exceed the combined cap we need realistic per-company
    // sizes near the cap. We'll use very long notes (NOTES cap 2K) and
    // populate summary just under its 6K cap and transcript just under
    // its 6K cap. 4 companies × ~14K = 56K — way under 300K, won't drop.
    // Instead the simplest way to test the cap is to lower our use of
    // it by inserting 50 companies each with 5 long meetings. That's a
    // lot of insert work. Easier: directly stress with a single huge
    // unbounded field — use raw transcriptSegments with many short
    // entries summing to large total. flattenSegments then truncates
    // per-meeting to 6K, so total per company ≈ ~14K. 50 companies =
    // 700K which clearly exceeds 300K → some should drop.
    const companyIds: string[] = []
    for (let i = 0; i < 30; i++) {
      const cid = await insertCompany(userId, `Cap Co ${i}`, {
        description: 'A'.repeat(2000), // boost per-company size
      })
      companyIds.push(cid)
      const mid = await insertMeeting(userId, {
        title: `Meeting ${i}`,
        notes: 'N'.repeat(2_500), // truncates to 2K + marker per cap
        summary: 'S'.repeat(7_000), // truncates to 6K + marker per cap
        transcriptSegments: [
          { speaker: 1, text: 'T'.repeat(7_000), startTime: 0, endTime: 1 },
        ],
      })
      await linkMeetingToCompany(mid, cid)
    }

    const output = await buildSelectedCompaniesContext(db, companyIds, userId)
    expect(output).not.toBeNull()
    // Per-company size after truncation ≈ 16K (notes 2K + summary 6K +
    // transcript 6K + headers ~2K). 30 × 16K = ~480K > 300K cap. Some
    // companies must be dropped.
    expect(output!.length).toBeLessThanOrEqual(300_000 + 1_000) // tolerance for boundary check
    // At least one company should be absent from the output.
    const presentCount = companyIds.filter((_, i) =>
      output!.includes(`COMPANY: Cap Co ${i}`),
    ).length
    expect(presentCount).toBeLessThan(companyIds.length)
    // And the first few SHOULD be present (loop stops mid-way, doesn't drop earlier).
    expect(output).toContain('COMPANY: Cap Co 0')
    void big
  })

  test('8. buildCompanyContextForChat delegation parity', async () => {
    const { userId } = await setupUser()
    const cid = await insertCompany(userId, 'Delegate Co', {
      industry: 'AI',
      stage: 'Seed',
      description: 'A test company.',
    })
    const mid = await insertMeeting(userId, {
      title: 'Delegate meeting',
      notes: 'shared notes',
      summary: 'shared summary',
      transcriptSegments: [
        { speaker: 1, text: 'shared transcript line', startTime: 0, endTime: 1 },
      ],
    })
    await linkMeetingToCompany(mid, cid)

    const singleOut = await buildCompanyContextForChat(db, cid, userId)
    const multiOut = await buildSelectedCompaniesContext(db, [cid], userId)
    expect(singleOut).not.toBeNull()
    expect(singleOut).toBe(multiOut)
    expect(singleOut).toContain('Summary:\nshared summary')
    // flattenSegments uses speakerLabel (resolved name) or falls back to
    // 'Speaker' — we passed only the numeric speaker index so we get the fallback.
    expect(singleOut).toContain('Transcript:\nSpeaker: shared transcript line')
    expect(singleOut).toContain('Notes:\nshared notes')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 2.5 — buildContactContextForChat
// ──────────────────────────────────────────────────────────────────────────

describe('buildContactContextForChat — meeting enrichment', () => {
  test('10. contact context includes Notes/Summary/Transcript per linked meeting', async () => {
    const { userId } = await setupUser()
    const contactId = await insertContact(userId, 'Syed Founder')
    const mid = await insertMeeting(userId, {
      title: 'Vitals Vault founder sync',
      notes: 'Founder shared roadmap.',
      summary: 'Roadmap discussion + competitive landscape.',
      transcriptSegments: [
        { speaker: 1, text: 'Mentioned peptide company.', startTime: 0, endTime: 5 },
      ],
    })
    await linkContactToMeeting(mid, contactId)

    const output = await buildContactContextForChat(db, contactId, userId)
    expect(output).not.toBeNull()
    expect(output).toContain('CONTACT: Syed Founder')
    expect(output).toContain('Meeting: Vitals Vault founder sync')
    expect(output).toContain('Notes:\nFounder shared roadmap.')
    expect(output).toContain('Summary:\nRoadmap discussion')
    expect(output).toContain('Transcript:\nSpeaker: Mentioned peptide company.')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 2.5 — prompt-cache segmented system prompt
// ──────────────────────────────────────────────────────────────────────────

describe('buildChatSessionSystemSegments — prompt cache control', () => {
  test('9a. null context → single base segment, no cache_control', () => {
    const segs = buildChatSessionSystemSegments(null)
    expect(segs).toHaveLength(1)
    const first = (segs as Array<{ type: string; text: string; cache_control?: unknown }>)[0]
    expect(first?.type).toBe('text')
    expect(first?.text).toContain('You are Cyggie')
    expect(first?.cache_control).toBeUndefined()
  })

  test('9b. non-null context → base + context segment with ephemeral cache_control', () => {
    const segs = buildChatSessionSystemSegments('COMPANY: Acme\nIndustry: AI')
    expect(segs).toHaveLength(2)
    const [base, ctx] = segs as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(base?.type).toBe('text')
    expect(base?.text).toContain('You are Cyggie')
    expect(base?.cache_control).toBeUndefined()
    expect(ctx?.type).toBe('text')
    expect(ctx?.text).toContain('COMPANY: Acme')
    expect(ctx?.text).toContain('Ground your answers')
    expect(ctx?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('9c. cacheEnabled=false → context segment omits cache_control (text unchanged for byte-stability)', () => {
    const ctxText = 'COMPANY: Acme\nIndustry: AI'
    const cached = buildChatSessionSystemSegments(ctxText, true)
    const uncached = buildChatSessionSystemSegments(ctxText, false)
    const [, cachedCtx] = cached as Array<{ text: string; cache_control?: unknown }>
    const [, uncachedCtx] = uncached as Array<{ text: string; cache_control?: unknown }>
    // Same text bytes — cache breakpoint is the only difference.
    expect(uncachedCtx?.text).toBe(cachedCtx?.text)
    expect(cachedCtx?.cache_control).toEqual({ type: 'ephemeral' })
    expect(uncachedCtx?.cache_control).toBeUndefined()
  })

  test('9d. cacheEnabled=false with null context → still single base segment', () => {
    const segs = buildChatSessionSystemSegments(null, false)
    expect(segs).toHaveLength(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// buildContextForSession — per-entity prefix stripping
//
// Regression coverage for the May 2026 bug where mobile per-entity chats
// ("Ask about Vital's Vault") got an empty context block because the
// gateway dispatcher passed contextId="company:<uuid>" straight to
// buildCompanyContextForChat, which then queried orgCompanies.id =
// "company:<uuid>" (zero rows) and returned null. The dispatcher now
// calls stripContextIdPrefix to drop the "<kind>:" prefix before
// delegating. One test per kind so a future refactor that only touches
// one arm is caught.
// ──────────────────────────────────────────────────────────────────────────

describe('buildContextForSession — strips <kind>: prefix before delegating', () => {
  test('11. company kind — contextId="company:<id>" resolves to the company block', async () => {
    const { userId } = await setupUser()
    const uniq = createId().slice(0, 6)
    const cid = await insertCompany(userId, `PerEntity Company ${uniq}`, {
      industry: 'Healthcare',
      stage: 'Series A',
      description: 'A test company.',
    })
    const mid = await insertMeeting(userId, {
      title: 'Per-entity company sync',
      summary: 'Revenue is $4M ARR.',
    })
    await linkMeetingToCompany(mid, cid)

    const session = await insertEntitySession(userId, 'company', cid)
    const output = await buildContextForSession(db, session)

    expect(output).not.toBeNull()
    expect(output).toContain(`COMPANY: PerEntity Company ${uniq}`)
    expect(output).toContain('Summary:\nRevenue is $4M ARR.')
  })

  test('12. meeting kind — contextId="meeting:<id>" resolves to the meeting block', async () => {
    const { userId } = await setupUser()
    const mid = await insertMeeting(userId, {
      title: 'Founder intro call',
      notes: 'Talked through the deck.',
      transcriptSegments: [
        { speaker: 1, text: 'Walked through our roadmap.', startTime: 0, endTime: 5 },
      ],
    })

    const session = await insertEntitySession(userId, 'meeting', mid)
    const output = await buildContextForSession(db, session)

    expect(output).not.toBeNull()
    expect(output).toContain('Founder intro call')
    expect(output).toContain('Talked through the deck.')
  })

  test('13. contact kind — contextId="contact:<id>" resolves to the contact block', async () => {
    const { userId } = await setupUser()
    const uniq = createId().slice(0, 6)
    const cid = await insertCompany(userId, `PerEntity Contact-Co ${uniq}`)
    const contactName = `PerEntity Founder ${uniq}`
    const contactId = await insertContact(userId, contactName, cid)
    const mid = await insertMeeting(userId, {
      title: 'Founder 1:1',
      summary: 'Discussed funding plans.',
    })
    await linkContactToMeeting(mid, contactId)

    const session = await insertEntitySession(userId, 'contact', contactId)
    const output = await buildContextForSession(db, session)

    expect(output).not.toBeNull()
    expect(output).toContain(`CONTACT: ${contactName}`)
    expect(output).toContain('Summary:\nDiscussed funding plans.')
  })

  test('14. dispatcher tolerates legacy bare contextId (idempotent strip)', async () => {
    // Some older sessions (and desktop-created meeting sessions per
    // src/shared/utils/chat-context.ts) store contextId without the
    // "<kind>:" prefix. The strip helper is a no-op for those, so the
    // dispatcher must still resolve them correctly.
    const { userId } = await setupUser()
    const uniq = createId().slice(0, 6)
    const companyName = `PerEntity BareID ${uniq}`
    const cid = await insertCompany(userId, companyName)
    const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
    await db.insert(schema.chatSessions).values({
      id,
      userId,
      contextId: cid, // bare — no "company:" prefix
      contextKind: 'company',
      contextLabel: null,
      title: null,
      lamport: '1',
      lastMessageAt: new Date(),
      createdByUserId: userId,
    })
    createdSessionIds.push(id)
    const rows = await db
      .select()
      .from(schema.chatSessions)
      .where(inArray(schema.chatSessions.id, [id]))

    const output = await buildContextForSession(db, rows[0]!)
    expect(output).not.toBeNull()
    expect(output).toContain(`COMPANY: ${companyName}`)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// stripContextIdPrefix — unit
// ──────────────────────────────────────────────────────────────────────────

describe('stripContextIdPrefix', () => {
  test('15. strips matching prefix', () => {
    expect(stripContextIdPrefix('company', 'company:abc-123')).toBe('abc-123')
    expect(stripContextIdPrefix('meeting', 'meeting:xyz')).toBe('xyz')
    expect(stripContextIdPrefix('contact', 'contact:foo')).toBe('foo')
  })

  test('16. no-op for bare IDs (legacy rows + crm context)', () => {
    expect(stripContextIdPrefix('company', 'abc-123')).toBe('abc-123')
    expect(stripContextIdPrefix('meeting', 'bareMeetingUuid')).toBe('bareMeetingUuid')
  })

  test('17. no-op when prefix is for a different kind', () => {
    // Defensive: feeding the wrong kind doesn't accidentally chew the colon.
    expect(stripContextIdPrefix('meeting', 'company:abc')).toBe('company:abc')
  })
})
