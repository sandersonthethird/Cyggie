/**
 * Meeting-chat context assembly — the meeting-aware AI Chat feature.
 *
 *   queryMeeting(meetingId, q, attachments, attachedContext?)
 *     ├─ primary: the meeting's transcript / notes / summary
 *     └─ optional: `attachedContext` markdown (companies/contacts the user
 *        attached via "+ Add context"), appended under "## Attached context"
 *
 *   buildUnifiedEntitiesContext(refs, { excludeMeetingId })
 *     └─ drops the anchor meeting from the attached set so a meeting chat doesn't
 *        carry the viewed call twice (full transcript + 3k-truncated copy).
 *
 * Mock boundaries mirror parity.test.ts: provider captures (system, user),
 * repos + file readers return fixtures.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { stubModule } from './_fixtures/mock-module'

// ── Provider mock — captures prompts ────────────────────────────────────
let capturedSystem = ''
let capturedUser = ''

vi.mock('@cyggie/services/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (system: string, user: string) => {
      capturedSystem = system
      capturedUser = user
      return 'mock-llm-response'
    },
  }),
}))

vi.mock('@cyggie/services/llm/send-progress', () => ({
  sendProgress: () => {},
}))

// ── Repo + file-reader mocks ────────────────────────────────────────────
const mockGetMeeting = vi.fn()
const mockGetCompany = vi.fn()
const mockListCompanyMeetings = vi.fn()
const mockReadSummary = vi.fn()
const mockReadTranscript = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () =>
  stubModule({ getMeeting: (...a: unknown[]) => mockGetMeeting(a[0]) }),
)

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () =>
  stubModule({
    getCompany: (...a: unknown[]) => mockGetCompany(a[0]),
    listCompanyMeetings: (...a: unknown[]) => mockListCompanyMeetings(a[0]),
    listCompanyEmailMessagesForChat: () => [],
  }),
)

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () =>
  stubModule({
    getContact: () => null,
    listContactEmailMessagesForChat: () => [],
  }),
)

vi.mock('@cyggie/db/sqlite/repositories/user-preferences.repo', () => ({
  getPreference: () => null,
}))

vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () =>
  stubModule({ getFlaggedFilesDetailed: () => [] }),
)

vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: () => [] }),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...a: unknown[]) => mockReadSummary(a[0]),
  readTranscript: (...a: unknown[]) => mockReadTranscript(a[0]),
  readLocalFile: async () => null,
}))

const { queryMeeting } = await import('@cyggie/services/llm/chat')
const { buildUnifiedEntitiesContext } = await import('@cyggie/services/llm/entities-chat')

const FIXTURE_DATE = '2026-05-02T15:00:00Z'

function meetingFixture(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    title: 'Init Labs partner call',
    date: FIXTURE_DATE,
    transcriptPath: '/fake/transcript.txt',
    summaryPath: '/fake/summary.txt',
    notes: 'Quick notes from the call.',
    speakerMap: { 0: 'Sandy Wright', 1: 'Priya Mehta' },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedSystem = ''
  capturedUser = ''
  mockGetMeeting.mockReturnValue(null)
  mockListCompanyMeetings.mockReturnValue([])
  mockReadSummary.mockReturnValue(null)
  mockReadTranscript.mockReturnValue(null)
})

describe('queryMeeting — primary meeting context', () => {
  it('includes transcript, notes, and summary under the meeting system prompt', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadTranscript.mockReturnValue('Sandy: How is pricing? Priya: Held at $180.')
    mockReadSummary.mockReturnValue('Q2 partner call summary.')

    const result = await queryMeeting('m1', 'What about pricing?', [])

    expect(result).toBe('mock-llm-response')
    expect(capturedUser).toContain('## Transcript')
    expect(capturedUser).toContain('Held at $180')
    expect(capturedUser).toContain('## User Notes')
    expect(capturedUser).toContain('## AI Summary')
    expect(capturedUser).not.toContain('## Attached context')
    expect(capturedSystem).toContain('questions about a meeting')
  })

  // Issue 2 — in-person / notes-only meetings must NOT error.
  it('does not throw for a notes-only meeting (no transcript, no summary)', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture({ transcriptPath: null, summaryPath: null }))

    const result = await queryMeeting('m1', 'Recap?', [])

    expect(result).toBe('mock-llm-response')
    expect(capturedUser).toContain('## User Notes')
    expect(capturedUser).not.toContain('## Transcript')
  })

  it('throws only when the meeting has no transcript, notes, or summary and no attached context', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture({ transcriptPath: null, summaryPath: null, notes: null }))

    await expect(queryMeeting('m1', 'Anything?', [])).rejects.toThrow(/No transcript, notes, or summary/i)
  })
})

describe('queryMeeting — with attached context', () => {
  it('appends attached markdown under "## Attached context" and switches to the combined prompt', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture())
    mockReadTranscript.mockReturnValue('transcript body')

    const result = await queryMeeting('m1', 'q', [], '# Company: Init Labs\nrecent emails…')

    expect(result).toBe('mock-llm-response')
    expect(capturedUser).toContain('## Transcript')
    expect(capturedUser).toContain('## Attached context')
    expect(capturedUser).toContain('# Company: Init Labs')
    expect(capturedSystem).toContain('research assistant for a venture capital firm')
  })

  it('still answers when only the attached context has content (meeting empty)', async () => {
    mockGetMeeting.mockReturnValue(meetingFixture({ transcriptPath: null, summaryPath: null, notes: null }))

    const result = await queryMeeting('m1', 'q', [], '# Company: Init Labs\nhistory')

    expect(result).toBe('mock-llm-response')
    expect(capturedUser).toContain('## Attached context')
  })
})

describe('buildUnifiedEntitiesContext — excludeMeetingId (Issue 1 dedupe)', () => {
  it('drops the anchor meeting from an attached company so it is not duplicated', async () => {
    mockGetCompany.mockReturnValue({ id: 'co1', canonicalName: 'Init Labs', description: 'AI infra' })
    mockListCompanyMeetings.mockReturnValue([
      { id: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE },
      { id: 'm2', title: 'Init Labs follow-up', date: FIXTURE_DATE },
    ])
    // getMeeting is hit by the meetings-section loader for each kept meeting.
    mockGetMeeting.mockImplementation((id: string) => meetingFixture({ id, transcriptPath: null }))
    mockReadSummary.mockReturnValue('summary text')

    const { markdown } = await buildUnifiedEntitiesContext(
      [{ type: 'company', id: 'co1' }],
      { excludeMeetingId: 'm1' },
    )

    expect(markdown).toBeTruthy()
    // The anchor meeting is excluded; the other meeting survives.
    expect(markdown).not.toContain('Init Labs partner call')
    expect(markdown).toContain('Init Labs follow-up')
  })

  it('includes the meeting when no exclusion is requested (default behavior unchanged)', async () => {
    mockGetCompany.mockReturnValue({ id: 'co1', canonicalName: 'Init Labs', description: 'AI infra' })
    mockListCompanyMeetings.mockReturnValue([{ id: 'm1', title: 'Init Labs partner call', date: FIXTURE_DATE }])
    mockGetMeeting.mockImplementation((id: string) => meetingFixture({ id, transcriptPath: null }))
    mockReadSummary.mockReturnValue('summary text')

    const { markdown } = await buildUnifiedEntitiesContext([{ type: 'company', id: 'co1' }])

    expect(markdown).toContain('Init Labs partner call')
  })
})
