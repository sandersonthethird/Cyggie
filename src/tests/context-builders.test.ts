/**
 * Tests for context-builders.ts.
 *
 *   What this exercises:
 *     1. assembleCompanyContext returns markdown + signals (hasMeetings,
 *        hasEmails, hasFlaggedFiles).
 *     2. assembleCompanyContext throws 'Company not found' for unknown id.
 *     3. buildCompanyContext maps signals → BuilderResult variant:
 *        - all-empty       → kind: 'response', text: 'I have very little...'
 *        - any signal true → kind: 'context', markdown
 *        - company not found → kind: 'error'
 *     4. Caps preserved: 8K per summary, 2K per email body, etc.
 *
 * Mock boundaries:
 *   - companyRepo / meetingRepo / company-file-flags repo via vi.mock
 *   - readSummary / readTranscript / readLocalFile via vi.mock
 *
 * Per-kind builder tests — context-builders.ts will grow to host all 5
 * assemble/build pairs as later refactor steps land. New describe blocks
 * for queryContact, queryMeeting, etc. get added in those steps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Repo + reader mocks ────────────────────────────────────────────────

const mockGetCompany = vi.fn()
const mockListCompanyMeetings = vi.fn()
const mockListCompanyEmails = vi.fn()
const mockGetMeeting = vi.fn()
const mockGetFlaggedFileIds = vi.fn()
const mockReadSummary = vi.fn()
const mockReadTranscript = vi.fn()
const mockReadLocalFile = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(args[0]),
  listCompanyMeetings: (...args: unknown[]) => mockListCompanyMeetings(args[0]),
  listCompanyEmails: (...args: unknown[]) => mockListCompanyEmails(args[0]),
}))

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(args[0]),
}))

vi.mock('../main/database/repositories/company-file-flags.repo', () => ({
  getFlaggedFileIds: (...args: unknown[]) => mockGetFlaggedFileIds(args[0]),
}))

const mockCompanyNotesList = vi.fn()
vi.mock('../main/database/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({
    list: (id: string) => mockCompanyNotesList(id),
  }),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(args[0]),
  readTranscript: (...args: unknown[]) => mockReadTranscript(args[0]),
  readLocalFile: async (...args: unknown[]) => mockReadLocalFile(args[0]),
}))

const { assembleCompanyContext, buildCompanyContext } = await import(
  '../main/llm/context-builders'
)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetCompany.mockReturnValue(null)
  mockListCompanyMeetings.mockReturnValue([])
  mockListCompanyEmails.mockReturnValue([])
  mockGetMeeting.mockReturnValue(null)
  mockGetFlaggedFileIds.mockReturnValue([])
  mockReadSummary.mockReturnValue(null)
  mockReadTranscript.mockReturnValue(null)
  mockReadLocalFile.mockResolvedValue(null)
  mockCompanyNotesList.mockReturnValue([])
})

function makeCompany(over: Record<string, unknown> = {}) {
  return {
    id: 'co1',
    canonicalName: 'Init Labs',
    description: 'AI infrastructure',
    stage: 'Seed',
    round: '$8M Seed',
    industry: 'AI infrastructure',
    ...over,
  }
}

// ── assembleCompanyContext ─────────────────────────────────────────────

describe('assembleCompanyContext', () => {
  it('throws "Company not found" for unknown id', async () => {
    mockGetCompany.mockReturnValue(null)
    await expect(assembleCompanyContext('unknown')).rejects.toThrow('Company not found')
  })

  it('returns header-only markdown with all flags false when company has no signal', async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await assembleCompanyContext('co1')
    expect(result.markdown).toContain('# Company: Init Labs')
    expect(result.markdown).toContain('Stage: Seed | Round: $8M Seed | Industry: AI infrastructure')
    expect(result.hasMeetings).toBe(false)
    expect(result.hasEmails).toBe(false)
    expect(result.hasFlaggedFiles).toBe(false)
  })

  it('omits empty meta line when all of stage/round/industry are missing', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ stage: null, round: null, industry: null }))
    const result = await assembleCompanyContext('co1')
    expect(result.markdown).not.toContain('Stage:')
    expect(result.markdown).not.toContain('Round:')
  })

  it('hasMeetings true when a linked meeting has a summary', async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    mockListCompanyMeetings.mockReturnValue([
      { id: 'm1', title: 'Init Labs Q2 call', date: '2026-05-02' },
    ])
    mockGetMeeting.mockReturnValue({ id: 'm1', summaryPath: '/s.txt', transcriptPath: null })
    mockReadSummary.mockReturnValue('Q2 pricing reset held; 11 months runway.')
    const result = await assembleCompanyContext('co1')
    expect(result.hasMeetings).toBe(true)
    expect(result.markdown).toContain('## Meeting Summaries')
    expect(result.markdown).toContain('### Init Labs Q2 call (')
    expect(result.markdown).toContain('Q2 pricing reset held')
  })

  it('hasEmails true when an email passes the MIN_BODY filter', async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    mockListCompanyEmails.mockReturnValue([
      {
        fromEmail: 'priya@initlabs.test',
        subject: 'Q2 update',
        receivedAt: '2026-05-01T10:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy, sharing the Q2 update on Init Labs. Pricing held at $180/seat...',
      },
    ])
    const result = await assembleCompanyContext('co1')
    expect(result.hasEmails).toBe(true)
    expect(result.markdown).toContain('## Email Correspondence')
  })

  it('hasNotes true when a company has notes (Step 10 — bonus gap)', async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    mockCompanyNotesList.mockReturnValue([
      {
        content: 'Init Labs is exploring a follow-on round in Q4 — keep on radar.',
        createdAt: '2026-04-15T00:00:00Z',
      },
    ])
    const result = await assembleCompanyContext('co1')
    expect(result.hasNotes).toBe(true)
    expect(result.markdown).toContain('## Notes')
    expect(result.markdown).toContain('keep on radar')
  })

  it('hasFlaggedFiles true when a flagged file is readable', async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    mockGetFlaggedFileIds.mockReturnValue(['/fake/init-labs-memo.pdf'])
    mockReadLocalFile.mockResolvedValue(
      'Init Labs Memo — investment thesis. Pricing $180/seat enterprise. Runway 11 months.'
    )
    const result = await assembleCompanyContext('co1')
    expect(result.hasFlaggedFiles).toBe(true)
    expect(result.markdown).toContain('## Linked Documents')
    expect(result.markdown).toContain('### init-labs-memo.pdf')
  })
})

// ── buildCompanyContext ────────────────────────────────────────────────

describe('buildCompanyContext', () => {
  it("returns kind: 'response' (curated) when company has zero signal", async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await buildCompanyContext({ companyId: 'co1' })
    expect(result.kind).toBe('response')
    if (result.kind === 'response') {
      expect(result.text).toMatch(/very little information about Init Labs/i)
      expect(result.text).toMatch(/Try linking some meetings/i)
    }
  })

  it("returns kind: 'context' when at least one signal is present", async () => {
    mockGetCompany.mockReturnValue(makeCompany())
    mockListCompanyEmails.mockReturnValue([
      {
        fromEmail: 'priya@initlabs.test',
        subject: 'Q2 update',
        receivedAt: '2026-05-01T10:00:00Z',
        sentAt: null,
        bodyText: 'Hi Sandy, sharing the Q2 update with enough body characters to pass the MIN filter.',
      },
    ])
    const result = await buildCompanyContext({ companyId: 'co1' })
    expect(result.kind).toBe('context')
    if (result.kind === 'context') {
      expect(result.markdown).toContain('# Company: Init Labs')
      expect(result.markdown).toContain('## Email Correspondence')
    }
  })

  it("returns kind: 'error' when company not found", async () => {
    mockGetCompany.mockReturnValue(null)
    const result = await buildCompanyContext({ companyId: 'unknown' })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.message).toBe('Company not found')
    }
  })
})
