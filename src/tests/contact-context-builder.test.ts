/**
 * Tests for contact-context-builder.ts
 *
 * Mock boundaries:
 *   - contactRepo.getContact / listContactEmails → vi.mock (avoids full DB schema setup)
 *   - contactNotesRepo.listContactNotes → vi.mock
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

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: (...args: unknown[]) => mockGetContact(args[0] as string),
  listContactEmails: (...args: unknown[]) => mockListContactEmails(args[0] as string),
}))

vi.mock('../main/database/repositories/contact-notes.repo', () => ({
  listContactNotes: (...args: unknown[]) => mockListContactNotes(args[0] as string),
}))

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(args[0] as string),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(args[0] as string),
  readTranscript: (...args: unknown[]) => mockReadTranscript(args[0] as string),
}))

const { buildContactContext } = await import('../main/llm/contact-context-builder')

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
    investorStage: null,
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

describe('buildContactContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListContactEmails.mockReturnValue([])
    mockListContactNotes.mockReturnValue([])
    mockGetMeeting.mockReturnValue(null)
    mockReadSummary.mockReturnValue(null)
    mockReadTranscript.mockReturnValue(null)
  })

  it('throws "Contact not found" for unknown contactId', () => {
    mockGetContact.mockReturnValue(null)
    expect(() => buildContactContext('unknown-id')).toThrow('Contact not found')
  })

  it('includes contact name in context header', () => {
    mockGetContact.mockReturnValue(makeContact())
    const { context } = buildContactContext('c1')
    expect(context).toContain('# Contact: Jane Smith')
  })

  it('returns all flags false when contact has no data', () => {
    mockGetContact.mockReturnValue(makeContact())
    const result = buildContactContext('c1')
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
    const result = buildContactContext('c1')
    expect(result.hasMeetings).toBe(true)
    expect(result.context).toContain('Meeting Summaries')
    expect(result.context).toContain('Great meeting with Jane.')
  })

  it('sets hasMeetings true when a meeting has a transcript (no summary)', () => {
    mockGetContact.mockReturnValue(makeContact({
      meetings: [{ id: 'm2', title: 'Follow-up', date: '2024-07-01', status: 'completed', durationSeconds: null }]
    }))
    mockGetMeeting.mockReturnValue({ summaryPath: null, transcriptPath: '/path/to/transcript.txt' })
    mockReadTranscript.mockReturnValue('Speaker: Hello, Jane.')
    const result = buildContactContext('c1')
    expect(result.hasMeetings).toBe(true)
    expect(result.context).toContain('Meeting Transcripts')
  })

  it('sets hasEmails true when an email has a body', () => {
    mockGetContact.mockReturnValue(makeContact())
    mockListContactEmails.mockReturnValue([{
      id: 'e1',
      subject: 'Partnership inquiry',
      fromEmail: 'jane@example.com',
      fromName: 'Jane Smith',
      receivedAt: '2024-05-01T10:00:00Z',
      sentAt: null,
      snippet: null,
      bodyText: 'Hi, I wanted to discuss a potential partnership with your fund.',
      isUnread: false,
      threadId: null,
      threadMessageCount: 1,
      participants: [],
    }])
    const result = buildContactContext('c1')
    expect(result.hasEmails).toBe(true)
    expect(result.context).toContain('Email Correspondence')
  })

  it('does NOT set hasEmails when email body is too short (< 50 chars)', () => {
    mockGetContact.mockReturnValue(makeContact())
    mockListContactEmails.mockReturnValue([{
      id: 'e2',
      subject: 'Hi',
      fromEmail: 'jane@example.com',
      fromName: null,
      receivedAt: null,
      sentAt: null,
      snippet: null,
      bodyText: 'Thanks!',
      isUnread: false,
      threadId: null,
      threadMessageCount: 1,
      participants: [],
    }])
    const result = buildContactContext('c1')
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
    const result = buildContactContext('c1')
    expect(result.hasNotes).toBe(true)
    expect(result.context).toContain('Notes')
    expect(result.context).toContain('Jane is interested in Series A')
  })
})
