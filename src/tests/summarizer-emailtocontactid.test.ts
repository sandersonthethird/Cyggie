/**
 * Regression test: summarizer.ts correctly extracts string contact IDs
 * from resolveContactsByEmails's { id, fullName } return shape.
 *
 * Mock boundaries:
 *   - electron              → { BrowserWindow: { getAllWindows: () => [] } }
 *   - meeting.repo          → vi.fn() (getMeeting, updateMeeting)
 *   - template.repo         → vi.fn() (getTemplate)
 *   - storage/file-manager  → vi.fn() (readTranscript, writeSummary)
 *   - llm/provider-factory  → stub returning a fast generateSummary
 *   - llm/critique          → pass-through
 *   - search.repo           → vi.fn()
 *   - company-summary-sync  → returns []
 *   - org-company.repo      → returns [] for listMeetingCompanies
 *   - services/note-companion-backfill → spy (createMeetingCompanionNote) ← key assertion
 *   - contact.repo          → resolveContactsByEmails returns { id, fullName } objects
 *   - task-extraction       → returns { proposed: [] }
 *   - contact-summary-sync  → returns []
 *   - google-auth           → hasDriveScope = false
 *   - user.repo             → getUser = null
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock: electron ───────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))

// ─── Mock: meetingRepo barrel ─────────────────────────────────────────────────
// Summarizer imports `* as meetingRepo from '@cyggie/db/sqlite/repositories'`
// (the sync-wrapped barrel) per CLAUDE.md, so writes flow through withSync
// → outbox. The unit test mocks the barrel directly — calling the real
// barrel here would require configureSyncGlobals() + a real SQLite + the
// outbox table, none of which this test cares about.

const mockGetMeeting = vi.fn()
const mockUpdateMeeting = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
}))

// ─── Mock: template.repo ──────────────────────────────────────────────────────

const mockGetTemplate = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/template.repo', () => ({
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

vi.mock('../main/storage/file-manager', () => ({
  readTranscript: () => '[SPEAKER_00]: Hello world',
  writeSummary: () => 'summaries/m1.md',
}))

// ─── Mock: provider-factory ───────────────────────────────────────────────────

vi.mock('@cyggie/services/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (_sys: string, _usr: string, onChunk: (c: string) => void) => {
      onChunk('Test summary output')
      return 'Test summary output'
    },
  }),
}))

// ─── Mock: critique ───────────────────────────────────────────────────────────

vi.mock('@cyggie/services/llm/critique', () => ({
  critiqueText: async (_provider: unknown, draft: string) => draft,
}))

// ─── Mock: search.repo ────────────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/search.repo', () => ({
  updateSummaryIndex: vi.fn(),
}))

// ─── Mock: company-summary-sync ───────────────────────────────────────────────

vi.mock('@cyggie/services/company-summary-sync.service', () => ({
  getVcSummaryCompanyUpdateProposals: async () => [],
}))

// ─── Mock: org-company.repo ───────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  listMeetingCompanies: () => [],
}))

// ─── Mock: note-companion-backfill.service (KEY SPY) ─────────────────────────
// Production routes both contact-side and company-side companion notes through
// createMeetingCompanionNote. The regression we're catching is that the
// contact-side call must receive a string `entityId` (extracted from
// resolveContactsByEmails's { id, fullName } shape), not the whole object.

const mockCreateCompanionNote = vi.fn()

vi.mock('../main/services/note-companion-backfill.service', () => ({
  createMeetingCompanionNote: (...args: unknown[]) => mockCreateCompanionNote(...args),
}))

// ─── Mock: contact.repo ───────────────────────────────────────────────────────
// Returns the NEW shape: { id, fullName } — this is what triggered the regression.

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  resolveContactsByEmails: () => ({
    'alice@example.com': { id: 'c1', fullName: 'Alice Smith' },
  }),
}))

// ─── Mock: task-extraction ────────────────────────────────────────────────────

vi.mock('@cyggie/services/task-extraction.service', () => ({
  extractTasksFromSummary: () => ({ proposed: [] }),
}))

// ─── Mock: contact-summary-sync ───────────────────────────────────────────────

vi.mock('@cyggie/services/contact-summary-sync.service', () => ({
  getContactSummaryUpdateProposals: async () => [],
}))

// ─── Mock: google-auth ────────────────────────────────────────────────────────

vi.mock('../main/calendar/google-auth', () => ({
  hasDriveScope: () => false,
}))

// ─── Mock: user.repo ──────────────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/user.repo', () => ({
  getUser: () => null,
}))

// ─── Mock: storage/paths ─────────────────────────────────────────────────────

vi.mock('../main/storage/paths', () => ({
  getSummariesDir: () => '/tmp/summaries',
}))

// ─── Subject under test ───────────────────────────────────────────────────────

const { generateSummary } = await import('@cyggie/services/llm/summarizer')

const FAKE_MEETING = {
  id: 'm1',
  transcriptPath: 'transcripts/m1.txt',
  attendeeEmails: ['alice@example.com'],
  speakerMap: {},
  speakerContactMap: {},
  title: 'Test Meeting',
  date: '2024-01-01T00:00:00.000Z',
  durationSeconds: 60,
  attendees: ['Alice Smith'],
  companies: undefined,
  notes: undefined,
  status: 'recorded',
}

const FAKE_TEMPLATE = {
  id: 't1',
  name: 'Test Template',
  category: 'general',
  systemPrompt: 'You are a meeting summarizer.',
  userPrompt: 'Summarize: {{transcript}}',
  userPromptTemplate: 'Summarize: {{transcript}}',
}

describe('generateSummary — emailToContactId regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMeeting.mockReturnValue(FAKE_MEETING)
    mockGetTemplate.mockReturnValue(FAKE_TEMPLATE)
    mockUpdateMeeting.mockReturnValue(undefined)
  })

  it('passes string entityId (not object) to createMeetingCompanionNote for contacts', async () => {
    await generateSummary('m1', 't1', null)

    // Find the contact-side call (entityType='contact'). The summarizer also
    // makes company-side calls — those are not the regression target.
    const contactCall = mockCreateCompanionNote.mock.calls.find(
      (call) => (call[0] as { entityType: string }).entityType === 'contact'
    )
    expect(contactCall).toBeDefined()

    const [payload] = contactCall!
    // Before the fix, entityId would be { id: 'c1', fullName: 'Alice Smith' }
    expect(payload.entityId).toBe('c1')
    expect(typeof payload.entityId).toBe('string')
  })
})

describe('generateSummary — Item 2: writes summary column for mobile read path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMeeting.mockReturnValue(FAKE_MEETING)
    mockGetTemplate.mockReturnValue(FAKE_TEMPLATE)
    mockUpdateMeeting.mockReturnValue(undefined)
  })

  it('dual-writes summary content to BOTH summaryPath AND the new summary column', async () => {
    await generateSummary('m1', 't1', null)

    // The post-generation updateMeeting call (the one that sets status to
    // summarized) MUST include the markdown body in the summary column so
    // the desktop → outbox → Neon path surfaces it to mobile via
    // GET /meetings/:id.
    const summarizedCall = mockUpdateMeeting.mock.calls.find(
      (call) => (call[1] as { status?: string }).status === 'summarized'
    )
    expect(summarizedCall).toBeDefined()

    const [meetingId, patch] = summarizedCall!
    expect(meetingId).toBe('m1')
    expect(patch.summary).toBe('Test summary output')
    expect(patch.summaryPath).toBe('summaries/m1.md')
    expect(patch.status).toBe('summarized')
  })
})
