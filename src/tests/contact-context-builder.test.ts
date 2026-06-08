/**
 * Tests for assembleContactContext (in context-builders.ts).
 *
 * Per /plan-eng-review Issue 1D, the legacy buildContactContext (in the now-
 * deleted contact-context-builder.ts) was split into a shared
 * assembleContactContext (used by chatDispatch AND contact-key-takeaways)
 * and a thin buildContactContext wrapper that returns BuilderResult. These
 * tests target the assembler — the wire-format semantics they exercise are
 * the function's actual contract.
 *
 * Mock boundaries:
 *   - contactRepo.getContact / listContactEmails → vi.mock (avoids full DB schema setup)
 *   - contactNotesRepo (notes-base factory) → vi.mock
 *   - meetingRepo.getMeeting → vi.mock
 *   - readSummary / readTranscript → vi.mock (avoids filesystem access)
 *
 * Covers:
 *   - throws 'Contact not found' when contactId is unknown
 *   - hasMeetings is true when a meeting has a summary
 *   - hasEmails is true when an email has a body
 *   - hasNotes is true when a note has content
 *   - all three flags are false when data is missing/empty
 *   - contact name appears in the context header
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContactDetail } from '../shared/types/contact'
import type { ContactEmailRef } from '../shared/types/contact'

// ── Repo mocks ──────────────────────────────────────────────────────────────

const mockGetContact = vi.fn<[string], ContactDetail | null>()
const mockListContactEmails = vi.fn<[string], ContactEmailRef[]>()
const mockListContactNotes = vi.fn()
const mockGetMeeting = vi.fn()
const mockReadSummary = vi.fn<[string], string | null>()
const mockReadTranscript = vi.fn<[string], string | null>()

const mockListContactEmailMessagesForChat = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: (...args: unknown[]) => mockGetContact(args[0] as string),
  listContactEmails: (...args: unknown[]) => mockListContactEmails(args[0] as string),
  // Part F — assembleContactContext now reconstructs threads from all messages.
  listContactEmailMessagesForChat: (...args: unknown[]) =>
    mockListContactEmailMessagesForChat(args[0], args[1]),
}))

// Part E — assembleContactContext reads the emailThreadsPerCompany pref; mock it
// so the test doesn't hit the real getDatabase() (Electron app.getPath).
const mockGetPreference = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/user-preferences.repo', () => ({
  getPreference: (...args: unknown[]) => mockGetPreference(args[0]),
}))

vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({
    list: (...args: unknown[]) => mockListContactNotes(args[0] as string),
  }),
}))

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(args[0] as string),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(args[0] as string),
  readTranscript: (...args: unknown[]) => mockReadTranscript(args[0] as string),
  readLocalFile: async () => null,
}))

const { assembleContactContext } = await import('@cyggie/services/llm/context-builders')

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<ContactDetail> = {}): ContactDetail {
  return {
    id: 'c1',
    fullName: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    normalizedName: 'jane smith',
    email: 'jane@example.com',
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    talentPipeline: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount: 0,
    emailCount: 0,
    lastTouchpoint: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    primaryCompany: null,
    emails: ['jane@example.com'],
    meetings: [],
    city: null,
    state: null,
    notes: null,
    phone: null,
    twitterHandle: null,
    otherSocials: null,
    timezone: null,
    pronouns: null,
    birthday: null,
    university: null,
    previousCompanies: null,
    tags: null,
    relationshipStrength: null,
    lastMetEvent: null,
    warmIntroPath: null,
    fundSize: null,
    typicalCheckSizeMin: null,
    typicalCheckSizeMax: null,
    investmentStageFocus: null,
    investmentSectorFocus: null,
    proudPortfolioCompanies: null,
    noteCount: 0,
    fieldSources: null,
    workHistory: null,
    educationHistory: null,
    linkedinHeadline: null,
    linkedinSkills: null,
    linkedinEnrichedAt: null,
    keyTakeaways: null,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('assembleContactContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListContactEmails.mockReturnValue([])
    mockListContactEmailMessagesForChat.mockReturnValue([])
    mockGetPreference.mockReturnValue(null)
    mockListContactNotes.mockReturnValue([])
    mockGetMeeting.mockReturnValue(null)
    mockReadSummary.mockReturnValue(null)
    mockReadTranscript.mockReturnValue(null)
  })

  it('throws "Contact not found" for unknown contactId', () => {
    mockGetContact.mockReturnValue(null)
    expect(() => assembleContactContext('unknown-id')).toThrow('Contact not found')
  })

  it('includes contact name in context header', () => {
    mockGetContact.mockReturnValue(makeContact())
    const { markdown } = assembleContactContext('c1')
    expect(markdown).toContain('# Contact: Jane Smith')
  })

  it('returns all flags false when contact has no data', () => {
    mockGetContact.mockReturnValue(makeContact())
    const result = assembleContactContext('c1')
    expect(result.hasMeetings).toBe(false)
    expect(result.hasEmails).toBe(false)
    expect(result.hasNotes).toBe(false)
  })

  it('sets hasMeetings true when a meeting has a summary', () => {
    mockGetContact.mockReturnValue(makeContact({
      meetings: [{ id: 'm1', title: 'Intro call', date: '2024-06-01', status: 'completed', durationSeconds: null }]
    }))
    mockGetMeeting.mockReturnValue({ summaryPath: '/path/to/summary.txt', transcriptPath: null })
    mockReadSummary.mockReturnValue('Great meeting with Jane.')
    const result = assembleContactContext('c1')
    expect(result.hasMeetings).toBe(true)
    expect(result.markdown).toContain('Meeting Summaries')
    expect(result.markdown).toContain('Great meeting with Jane.')
  })

  it('sets hasMeetings true when a meeting has a transcript (no summary)', () => {
    mockGetContact.mockReturnValue(makeContact({
      meetings: [{ id: 'm2', title: 'Follow-up', date: '2024-07-01', status: 'completed', durationSeconds: null }]
    }))
    mockGetMeeting.mockReturnValue({ summaryPath: null, transcriptPath: '/path/to/transcript.txt' })
    mockReadTranscript.mockReturnValue('Speaker: Hello, Jane.')
    const result = assembleContactContext('c1')
    expect(result.hasMeetings).toBe(true)
    expect(result.markdown).toContain('Meeting Transcripts')
  })

  it('sets hasEmails true when a two-way thread survives the filter', () => {
    mockGetContact.mockReturnValue(makeContact())
    // Part F: chat reconstructs threads from all messages (listContactEmailMessagesForChat).
    const body = 'Hi, I wanted to discuss a potential partnership with your fund in detail.'
    mockListContactEmailMessagesForChat.mockReturnValue([
      {
        messageId: 'e1', threadGroup: 'T1', fromName: 'Jane Smith', fromEmail: 'jane@example.com',
        subject: 'Partnership inquiry', direction: 'inbound', bodyText: body, labelsJson: '["INBOX"]',
        hasAttachments: false, receivedAt: '2024-05-01T10:00:00Z', sentAt: null,
        linkConfidence: 0.98, linkedBy: 'auto',
      },
      {
        messageId: 'e2', threadGroup: 'T1', fromName: 'Me', fromEmail: 'me@firm.test',
        subject: 'Re: Partnership inquiry', direction: 'outbound', bodyText: 'Happy to chat — sharing a few times.',
        labelsJson: '["SENT"]', hasAttachments: false, receivedAt: '2024-05-02T10:00:00Z', sentAt: null,
        linkConfidence: 0.98, linkedBy: 'auto',
      },
    ])
    const result = assembleContactContext('c1')
    expect(result.hasEmails).toBe(true)
    expect(result.markdown).toContain('Email Correspondence')
  })

  it('does NOT set hasEmails when the only thread is low-signal (short one-way)', () => {
    mockGetContact.mockReturnValue(makeContact())
    mockListContactEmailMessagesForChat.mockReturnValue([{
      messageId: 'e2', threadGroup: 'e2', fromName: null, fromEmail: 'jane@example.com',
      subject: 'Hi', direction: 'inbound', bodyText: 'Thanks!', labelsJson: '["INBOX"]',
      hasAttachments: false, receivedAt: null, sentAt: null, linkConfidence: 0.9, linkedBy: 'auto',
    }])
    const result = assembleContactContext('c1')
    expect(result.hasEmails).toBe(false)
  })

  it('sets hasNotes true when a note has content', () => {
    mockGetContact.mockReturnValue(makeContact())
    mockListContactNotes.mockReturnValue([{
      id: 'n1',
      content: 'Jane is interested in Series A companies with deep tech focus.',
      createdAt: '2024-04-01T00:00:00Z',
      updatedAt: '2024-04-01T00:00:00Z',
    }])
    const result = assembleContactContext('c1')
    expect(result.hasNotes).toBe(true)
    expect(result.markdown).toContain('Notes')
    expect(result.markdown).toContain('Jane is interested in Series A')
  })
})
