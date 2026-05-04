/**
 * PARITY BASELINE — locks the systemPrompt + userPrompt that each pre-refactor
 * `query*` function feeds to the LLM provider. After the chat-paths refactor,
 * the same scenarios must run through `chatDispatch` and produce byte-identical
 * snapshots.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ COMMIT #1 (this file): capture pre-refactor wire format         │
 *   │   for each of 5 kinds: meeting / search-results / company /     │
 *   │   contact / global. Snapshots locked into                       │
 *   │   src/tests/__snapshots__/parity/<kind>.snap.txt                │
 *   │                                                                  │
 *   │ COMMITS #2..N: refactor into chatDispatch                       │
 *   │                                                                  │
 *   │ FINAL: same scenarios via chatDispatch must match the locked    │
 *   │   snapshots. Any divergence = wire-format regression.           │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Mock boundaries (per-kind):
 *   - getProvider().generateSummary captures (system, user) prompts.
 *   - sendProgress is a no-op.
 *   - All repos called by the path are vi.mock'd to return fixtures.
 *   - readSummary / readTranscript / readLocalFile return fixture strings.
 *   - For the global path, getDatabase returns a stub that yields empty CRM
 *     results; buildMeetingContext is stubbed to a fixed markdown string.
 *
 * Why one scenario per kind, not exhaustive:
 *   This test isn't testing the BUILDERS — those have their own tests
 *   (context-formatters.test.ts, context-builders.test.ts). It's testing
 *   that the OVERALL DISPATCH wire format is preserved across the refactor.
 *   One realistic scenario per kind catches any structural regression.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Provider mock — captures prompts ────────────────────────────────────

let capturedSystem = ''
let capturedUser = ''

vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (system: string, user: string) => {
      capturedSystem = system
      capturedUser = user
      return 'mock-llm-response'
    },
  }),
}))

vi.mock('../main/llm/send-progress', () => ({
  sendProgress: () => {},
}))

// ── Repo + file-reader mocks ────────────────────────────────────────────

const mockGetMeeting = vi.fn()
const mockGetCompany = vi.fn()
const mockGetContact = vi.fn()
const mockListCompanyMeetingSummaryPaths = vi.fn()
const mockListCompanyMeetings = vi.fn()
const mockListCompanyEmails = vi.fn()
const mockListContactEmails = vi.fn()
const mockGetFlaggedFileIds = vi.fn()
const mockNotesList = vi.fn()
const mockReadSummary = vi.fn()
const mockReadTranscript = vi.fn()
const mockReadLocalFile = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(args[0]),
}))

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(args[0]),
  listCompanyMeetingSummaryPaths: (...args: unknown[]) => mockListCompanyMeetingSummaryPaths(args[0]),
  listCompanyMeetings: (...args: unknown[]) => mockListCompanyMeetings(args[0]),
  listCompanyEmails: (...args: unknown[]) => mockListCompanyEmails(args[0]),
}))

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: (...args: unknown[]) => mockGetContact(args[0]),
  listContactEmails: (...args: unknown[]) => mockListContactEmails(args[0]),
}))

vi.mock('../main/database/repositories/company-file-flags.repo', () => ({
  getFlaggedFileIds: (...args: unknown[]) => mockGetFlaggedFileIds(args[0]),
}))

vi.mock('../main/database/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: (id: string) => mockNotesList(id) }),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(args[0]),
  readTranscript: (...args: unknown[]) => mockReadTranscript(args[0]),
  readLocalFile: async (...args: unknown[]) => mockReadLocalFile(args[0]),
}))

// ── DB stub for queryAll's CRM SQL ──────────────────────────────────────
//
// queryAll → buildCrmContext (private to crm-chat.ts) → SQL via getDatabase().
// We don't want to spin up an in-memory SQLite here — that would couple this
// test to better-sqlite3's native module rebuild. Instead, stub getDatabase
// to return an object whose .prepare(...) returns empty results. The CRM
// branch of queryAll will produce '', and the meeting branch (mocked
// separately below) will produce the fixture string.
const stubStmt = {
  all: () => [],
  get: () => null,
  run: () => ({ changes: 0 }),
  iterate: function* () {},
}
const stubDb = {
  prepare: () => stubStmt,
  exec: () => undefined,
  pragma: () => [],
} as unknown as Parameters<typeof import('../main/database/connection').getDatabase>[0] extends never
  ? unknown
  : unknown

vi.mock('../main/database/connection', () => ({
  getDatabase: () => stubDb,
}))

// ── buildMeetingContext stub for queryAll path ──────────────────────────
//
// queryAll → buildGlobalContext (in context-builders.ts) → buildMeetingContext
// (still in chat.ts) cross-module, so vi.mock can intercept. Stubbed to a
// fixed markdown so the queryAll snapshot focuses on the OUTER composition
// under QUERY_ALL_SYSTEM_PROMPT. queryMeeting / querySearchResults run the
// real implementation.
const FIXTURE_MEETING_CONTEXT = `### "Init Labs partner call" (5/2/2026)
Participants: Sandy Wright, Priya Mehta

**Summary:**
Held the Q2 partner call. Discussed pricing reset and runway.

`

vi.mock('../main/llm/chat', async () => {
  const actual = await vi.importActual<typeof import('../main/llm/chat')>('../main/llm/chat')
  return {
    ...actual,
    buildMeetingContext: () => FIXTURE_MEETING_CONTEXT,
  }
})

// ── Imports under test (after all vi.mock calls) ────────────────────────

const { queryMeeting, querySearchResults } = await import('../main/llm/chat')
const { queryCompany } = await import('../main/llm/company-chat')
const { queryContact } = await import('../main/llm/contact-chat')
const { queryAll } = await import('../main/llm/crm-chat')
const { chatDispatch } = await import('../main/llm/chat-dispatch')

// ── Fixture data ────────────────────────────────────────────────────────

const FIXTURE_DATE = '2026-05-02T15:00:00Z'

function meetingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    title: 'Init Labs partner call',
    date: FIXTURE_DATE,
    transcriptPath: '/fake/transcript.txt',
    summaryPath: '/fake/summary.txt',
    notes: 'Quick notes from the call.',
    speakerMap: { 0: 'Sandy Wright', 1: 'Priya Mehta' },
    attendees: ['sandy@cyggie.test', 'priya@initlabs.test'],
    ...overrides,
  }
}

const FIXTURE_TRANSCRIPT = `Sandy: How is the pricing reset going?
Priya: We held at $180 per seat and renewed two design partners.
Sandy: What's the runway look like?
Priya: 11 months at the current burn rate.`

const FIXTURE_SUMMARY = `Held the Q2 partner call with Init Labs leadership.
- Pricing held at $180/seat enterprise; 2 design partners renewed.
- Runway: 11 months at $340K/mo burn.
- GTM bets: outbound motion via new SE hire (Q2 ramp).`

beforeEach(() => {
  vi.clearAllMocks()
  capturedSystem = ''
  capturedUser = ''
  // Sensible defaults — each test overrides what it needs.
  mockGetMeeting.mockReturnValue(null)
  mockListCompanyMeetingSummaryPaths.mockReturnValue([])
  mockListCompanyMeetings.mockReturnValue([])
  mockListCompanyEmails.mockReturnValue([])
  mockListContactEmails.mockReturnValue([])
  mockGetFlaggedFileIds.mockReturnValue([])
  mockNotesList.mockReturnValue([])
  mockReadSummary.mockReturnValue(null)
  mockReadTranscript.mockReturnValue(null)
  mockReadLocalFile.mockResolvedValue(null)
})

// ── Snapshot helper ─────────────────────────────────────────────────────

async function snapshotPrompts(kind: string) {
  const combined = `=== SYSTEM PROMPT ===\n${capturedSystem}\n\n=== USER PROMPT ===\n${capturedUser}\n`
  await expect(combined).toMatchFileSnapshot(`./__snapshots__/parity/${kind}.snap.txt`)
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('parity baseline — pre-refactor wire format per kind', () => {
  it('queryMeeting: single meeting with summary + transcript + notes', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockReadTranscript.mockReturnValue(FIXTURE_TRANSCRIPT)

    await queryMeeting('m1', 'What was the runway discussion?', [])

    await snapshotPrompts('queryMeeting')
  })

  it('querySearchResults: two meetings from a search result set', async () => {
    const m1 = meetingFixture({ id: 'm1', title: 'Init Labs partner call' })
    const m2 = meetingFixture({
      id: 'm2',
      title: 'Init Labs follow-up',
      date: '2026-05-09T15:00:00Z',
      transcriptPath: '/fake/transcript-2.txt',
      summaryPath: null,
    })
    mockGetMeeting.mockImplementation((id) => (id === 'm1' ? m1 : id === 'm2' ? m2 : null))
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockReadTranscript.mockReturnValue(FIXTURE_TRANSCRIPT)

    await querySearchResults(['m1', 'm2'], 'What did Priya say about pricing?', [])

    await snapshotPrompts('querySearchResults')
  })

  it('queryCompany: company overview + 1 meeting + 1 email + 1 flagged file', async () => {
    mockGetCompany.mockReturnValue({
      id: 'co1',
      canonicalName: 'Init Labs',
      description: 'AI infrastructure for VC firms',
      stage: 'Seed',
      round: '$8M Seed',
      industry: 'AI infrastructure',
    })
    mockListCompanyMeetingSummaryPaths.mockReturnValue([
      { meetingId: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE, summaryPath: '/fake/summary.txt' },
    ])
    mockListCompanyMeetings.mockReturnValue([
      { id: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE },
    ])
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockListCompanyEmails.mockReturnValue([
      {
        fromEmail: 'priya@initlabs.test',
        subject: 'Q2 update + pricing',
        receivedAt: '2026-05-01T10:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy, sharing the Q2 update on Init Labs. We held pricing at $180/seat for the enterprise tier; both design partners renewed. Runway sits at 11 months and we expect to push to a Series A in Q3.',
      },
    ])
    mockGetFlaggedFileIds.mockReturnValue(['/fake/init-labs-memo.pdf'])
    mockReadLocalFile.mockResolvedValue('Init Labs Memo: Investment Thesis\n\nAI infrastructure that abstracts cloud cost optimization. Pricing $180/seat enterprise. Two design partners renewed. Runway 11 months. Q3 Series A target.')

    await queryCompany('co1', 'How is pricing trending?', undefined)

    await snapshotPrompts('queryCompany')
  })

  it('queryContact: contact with 1 meeting + 1 email + 1 note', async () => {
    mockGetContact.mockReturnValue({
      id: 'ct1',
      fullName: 'Bobby Kwon',
      title: 'Partner',
      contactType: 'investor',
      primaryCompany: { canonicalName: 'Argonaut Capital' },
      meetings: [{ id: 'm1', title: 'Bobby intro', date: FIXTURE_DATE }],
    })
    mockGetMeeting.mockReturnValue(meetingFixture({ id: 'm1', title: 'Bobby intro' }))
    mockReadSummary.mockReturnValue('Met with Bobby Kwon at Argonaut Capital. Discussed his focus on Series A AI infrastructure.')
    mockListContactEmails.mockReturnValue([
      {
        fromEmail: 'bobby@argonaut.test',
        subject: 'Following up on intro',
        receivedAt: '2026-04-25T09:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy — great to meet last week. Wanted to flag two AI infrastructure companies that fit our thesis: Init Labs and Lumen AI. Let me know if either is on your radar.',
      },
    ])
    mockNotesList.mockReturnValue([
      {
        id: 'n1',
        content: 'Bobby tends to lead Series A rounds at $5-12M check size; sweet spot is technical founders with infra experience.',
        createdAt: '2026-04-15T00:00:00Z',
      },
    ])

    await queryContact('ct1', 'What does Bobby focus on?', undefined)

    await snapshotPrompts('queryContact')
  })

  it('queryAll: meeting context + (empty CRM) under QUERY_ALL_SYSTEM_PROMPT', async () => {
    // buildMeetingContext stubbed to FIXTURE_MEETING_CONTEXT (see vi.mock above).
    // buildCrmContext sees the empty stub DB → returns '' → only the meeting
    // section appears in the assembled context.
    await queryAll('What did Init Labs discuss?', [])

    await snapshotPrompts('queryAll')
  })
})

// ── Post-refactor: same fixtures via chatDispatch ──────────────────────────
//
// Re-runs the same 5 fixtures through chatDispatch and asserts byte-identical
// match against the snapshots locked in commit #1. Any divergence here means
// a wire-format regression introduced by the unify-chat-paths refactor.

describe('parity verify — same fixtures via chatDispatch produce identical snapshots', () => {
  it('chatDispatch kind=meeting matches queryMeeting snapshot', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockReadTranscript.mockReturnValue(FIXTURE_TRANSCRIPT)

    await chatDispatch({
      kind: { kind: 'meeting', meetingId: 'm1' },
      question: 'What was the runway discussion?',
      attachments: [],
    })

    await snapshotPrompts('queryMeeting')
  })

  it('chatDispatch kind=meetings matches querySearchResults snapshot', async () => {
    const m1 = meetingFixture({ id: 'm1', title: 'Init Labs partner call' })
    const m2 = meetingFixture({
      id: 'm2',
      title: 'Init Labs follow-up',
      date: '2026-05-09T15:00:00Z',
      transcriptPath: '/fake/transcript-2.txt',
      summaryPath: null,
    })
    mockGetMeeting.mockImplementation((id) => (id === 'm1' ? m1 : id === 'm2' ? m2 : null))
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockReadTranscript.mockReturnValue(FIXTURE_TRANSCRIPT)

    await chatDispatch({
      kind: { kind: 'meetings', meetingIds: ['m1', 'm2'] },
      question: 'What did Priya say about pricing?',
      attachments: [],
    })

    await snapshotPrompts('querySearchResults')
  })

  it('chatDispatch kind=company matches queryCompany snapshot', async () => {
    mockGetCompany.mockReturnValue({
      id: 'co1',
      canonicalName: 'Init Labs',
      description: 'AI infrastructure for VC firms',
      stage: 'Seed',
      round: '$8M Seed',
      industry: 'AI infrastructure',
    })
    mockListCompanyMeetingSummaryPaths.mockReturnValue([
      { meetingId: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE, summaryPath: '/fake/summary.txt' },
    ])
    mockListCompanyMeetings.mockReturnValue([
      { id: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE },
    ])
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadSummary.mockReturnValue(FIXTURE_SUMMARY)
    mockListCompanyEmails.mockReturnValue([
      {
        fromEmail: 'priya@initlabs.test',
        subject: 'Q2 update + pricing',
        receivedAt: '2026-05-01T10:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy, sharing the Q2 update on Init Labs. We held pricing at $180/seat for the enterprise tier; both design partners renewed. Runway sits at 11 months and we expect to push to a Series A in Q3.',
      },
    ])
    mockGetFlaggedFileIds.mockReturnValue(['/fake/init-labs-memo.pdf'])
    mockReadLocalFile.mockResolvedValue('Init Labs Memo: Investment Thesis\n\nAI infrastructure that abstracts cloud cost optimization. Pricing $180/seat enterprise. Two design partners renewed. Runway 11 months. Q3 Series A target.')

    await chatDispatch({
      kind: { kind: 'company', companyId: 'co1' },
      question: 'How is pricing trending?',
    })

    await snapshotPrompts('queryCompany')
  })

  it('chatDispatch kind=contact matches queryContact snapshot', async () => {
    mockGetContact.mockReturnValue({
      id: 'ct1',
      fullName: 'Bobby Kwon',
      title: 'Partner',
      contactType: 'investor',
      primaryCompany: { canonicalName: 'Argonaut Capital' },
      meetings: [{ id: 'm1', title: 'Bobby intro', date: FIXTURE_DATE }],
    })
    mockGetMeeting.mockReturnValue(meetingFixture({ id: 'm1', title: 'Bobby intro' }))
    mockReadSummary.mockReturnValue('Met with Bobby Kwon at Argonaut Capital. Discussed his focus on Series A AI infrastructure.')
    mockListContactEmails.mockReturnValue([
      {
        fromEmail: 'bobby@argonaut.test',
        subject: 'Following up on intro',
        receivedAt: '2026-04-25T09:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy — great to meet last week. Wanted to flag two AI infrastructure companies that fit our thesis: Init Labs and Lumen AI. Let me know if either is on your radar.',
      },
    ])
    mockNotesList.mockReturnValue([
      {
        id: 'n1',
        content: 'Bobby tends to lead Series A rounds at $5-12M check size; sweet spot is technical founders with infra experience.',
        createdAt: '2026-04-15T00:00:00Z',
      },
    ])

    await chatDispatch({
      kind: { kind: 'contact', contactId: 'ct1' },
      question: 'What does Bobby focus on?',
    })

    await snapshotPrompts('queryContact')
  })

  it('chatDispatch kind=global matches queryAll snapshot', async () => {
    await chatDispatch({
      kind: { kind: 'global' },
      question: 'What did Init Labs discuss?',
      attachments: [],
    })

    await snapshotPrompts('queryAll')
  })
})
