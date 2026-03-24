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
 *   - contact-notes.repo    → spy (createContactNote) ← key assertion
 *   - company-notes.repo    → vi.fn()
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

// ─── Mock: meeting.repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()
const mockUpdateMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
}))

// ─── Mock: template.repo ──────────────────────────────────────────────────────

const mockGetTemplate = vi.fn()

vi.mock('../main/database/repositories/template.repo', () => ({
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

vi.mock('../main/storage/file-manager', () => ({
  readTranscript: () => '[SPEAKER_00]: Hello world',
  writeSummary: () => 'summaries/m1.md',
}))

// ─── Mock: provider-factory ───────────────────────────────────────────────────

vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (_sys: string, _usr: string, onChunk: (c: string) => void) => {
      onChunk('Test summary output')
      return 'Test summary output'
    },
  }),
}))

// ─── Mock: critique ───────────────────────────────────────────────────────────

vi.mock('../main/llm/critique', () => ({
  critiqueText: async (_provider: unknown, draft: string) => draft,
}))

// ─── Mock: search.repo ────────────────────────────────────────────────────────

vi.mock('../main/database/repositories/search.repo', () => ({
  updateSummaryIndex: vi.fn(),
}))

// ─── Mock: company-summary-sync ───────────────────────────────────────────────

vi.mock('../main/services/company-summary-sync.service', () => ({
  getVcSummaryCompanyUpdateProposals: () => [],
}))

// ─── Mock: org-company.repo ───────────────────────────────────────────────────

vi.mock('../main/database/repositories/org-company.repo', () => ({
  listMeetingCompanies: () => [],
}))

// ─── Mock: company-notes.repo ─────────────────────────────────────────────────

const mockCreateCompanyNote = vi.fn()

vi.mock('../main/database/repositories/company-notes.repo', () => ({
  createCompanyNote: (...args: unknown[]) => mockCreateCompanyNote(...args),
}))

// ─── Mock: contact-notes.repo (KEY SPY) ──────────────────────────────────────

const mockCreateContactNote = vi.fn()

vi.mock('../main/database/repositories/contact-notes.repo', () => ({
  createContactNote: (...args: unknown[]) => mockCreateContactNote(...args),
}))

// ─── Mock: contact.repo ───────────────────────────────────────────────────────
// Returns the NEW shape: { id, fullName } — this is what triggered the regression.

vi.mock('../main/database/repositories/contact.repo', () => ({
  resolveContactsByEmails: () => ({
    'alice@example.com': { id: 'c1', fullName: 'Alice Smith' },
  }),
}))

// ─── Mock: task-extraction ────────────────────────────────────────────────────

vi.mock('../main/services/task-extraction.service', () => ({
  extractTasksFromSummary: () => ({ proposed: [] }),
}))

// ─── Mock: contact-summary-sync ───────────────────────────────────────────────

vi.mock('../main/services/contact-summary-sync.service', () => ({
  getContactSummaryUpdateProposals: async () => [],
}))

// ─── Mock: google-auth ────────────────────────────────────────────────────────

vi.mock('../main/calendar/google-auth', () => ({
  hasDriveScope: () => false,
}))

// ─── Mock: user.repo ──────────────────────────────────────────────────────────

vi.mock('../main/database/repositories/user.repo', () => ({
  getUser: () => null,
}))

// ─── Mock: storage/paths ─────────────────────────────────────────────────────

vi.mock('../main/storage/paths', () => ({
  getSummariesDir: () => '/tmp/summaries',
}))

// ─── Subject under test ───────────────────────────────────────────────────────

const { generateSummary } = await import('../main/llm/summarizer')

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

  it('passes string contactId (not object) to createContactNote', async () => {
    await generateSummary('m1', 't1', null)

    expect(mockCreateContactNote).toHaveBeenCalledOnce()
    const [payload] = mockCreateContactNote.mock.calls[0]
    // Before the fix, contactId would be { id: 'c1', fullName: 'Alice Smith' }
    expect(payload.contactId).toBe('c1')
    expect(typeof payload.contactId).toBe('string')
  })
})
