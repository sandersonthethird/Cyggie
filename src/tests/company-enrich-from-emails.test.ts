/**
 * Tests for getCompanyEnrichmentProposalsFromEmails() in company-summary-sync.service.ts
 *
 * Mock boundaries:
 *   - org-company.repo (getCompany, listCompanyEmails) → vi.fn() stubs
 *   - custom-fields.repo (listFieldDefinitions, getFieldValuesForEntity) → vi.fn() stubs
 *   - contact.repo → vi.fn() stubs (required by same module)
 *   - meeting.repo → vi.fn() stub (required by same module)
 *   - file-manager → vi.fn() stub (required by same module)
 *   - company-notes.repo → vi.fn() stub (required by same module)
 *   - database/connection → stubbed (repos are mocked; DB never called)
 *
 * The LLM provider is injected directly, so no module-level mock needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../main/database/connection', () => ({ getDatabase: vi.fn() }))

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(),
}))

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: vi.fn(),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
}))

vi.mock('../main/database/repositories/company-notes.repo', () => ({
  listCompanyNotes: vi.fn(() => []),
}))

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args),
}))

const mockGetCompany = vi.fn()
const mockListCompanyEmails = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
  listCompanyEmails: (...args: unknown[]) => mockListCompanyEmails(...args),
}))

const { getCompanyEnrichmentProposalsFromEmails } = await import(
  '../main/services/company-summary-sync.service'
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'co1',
    canonicalName: 'Acme Corp',
    description: null,
    round: null,
    raiseSize: null,
    postMoneyValuation: null,
    city: null,
    state: null,
    pipelineStage: null,
    fieldSources: null,
    ...overrides,
  }
}

function makeEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email1',
    subject: 'Intro call follow-up',
    fromEmail: 'founder@acme.com',
    fromName: 'Jane Founder',
    receivedAt: '2024-03-01T10:00:00Z',
    sentAt: null,
    snippet: 'We build AI-powered analytics for enterprise teams.',
    bodyText: null,
    isUnread: false,
    threadId: null,
    threadGroup: 'email1',
    providerThreadId: null,
    threadMessageCount: 1,
    participants: [],
    accountEmail: 'investor@vc.com',
    ...overrides,
  }
}

function makeProvider(response: string | (() => Promise<string>) = '{}') {
  return {
    generateSummary: vi.fn(async () => {
      if (typeof response === 'function') return response()
      return response
    }),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getCompanyEnrichmentProposalsFromEmails', () => {
  beforeEach(() => {
    mockListCompanyEmails.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
  })

  it('returns null when companyId is empty string', async () => {
    const result = await getCompanyEnrichmentProposalsFromEmails('', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when no emails have non-empty snippet', async () => {
    mockListCompanyEmails.mockReturnValue([
      makeEmail({ snippet: null }),
      makeEmail({ snippet: '   ' }),
    ])
    const result = await getCompanyEnrichmentProposalsFromEmails('co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when company not found', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromEmails('co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when LLM throws', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromEmails('co1', provider)
    expect(result).toBeNull()
  })

  it('returns null when safeParseJson returns null', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromEmails('co1', makeProvider('not valid json'))
    expect(result).toBeNull()
  })

  it('returns null when LLM response has no field changes vs current values', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(makeCompany({ description: 'AI analytics for enterprise teams' }))
    const result = await getCompanyEnrichmentProposalsFromEmails(
      'co1',
      makeProvider(JSON.stringify({ description: 'AI analytics for enterprise teams' }))
    )
    expect(result).toBeNull()
  })

  it('returns proposal with changes when LLM extracts new values', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromEmails(
      'co1',
      makeProvider(JSON.stringify({ description: 'AI-powered analytics platform' }))
    )
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co1')
    expect(result!.changes).toHaveLength(1)
    expect(result!.changes[0].field).toBe('description')
    expect(result!.changes[0].to).toBe('AI-powered analytics platform')
    expect(result!.updates.description).toBe('AI-powered analytics platform')
  })

  it('does NOT set fieldSources in proposal updates', async () => {
    mockListCompanyEmails.mockReturnValue([makeEmail()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromEmails(
      'co1',
      makeProvider(JSON.stringify({ description: 'New description' }))
    )
    expect(result).not.toBeNull()
    expect(result!.updates.fieldSources).toBeUndefined()
  })

  it('caps at 30 emails sorted newest-first', async () => {
    // Create 35 emails with sequential dates
    const emails = Array.from({ length: 35 }, (_, i) => makeEmail({
      id: `email${i}`,
      receivedAt: `2024-${String(i + 1).padStart(2, '0')}-01T00:00:00Z`.replace('2024-36', '2024-12').replace(/2024-(\d{3})/, '2024-12'),
      snippet: `Email ${i} content`,
    }))
    // Assign proper dates to ensure ordering
    const datedEmails = emails.map((e, i) => ({
      ...e,
      id: `email${i}`,
      receivedAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      snippet: `Email ${i} content`,
    }))
    mockListCompanyEmails.mockReturnValue(datedEmails)
    mockGetCompany.mockReturnValue(makeCompany())

    const provider = makeProvider(JSON.stringify({ description: 'Capped' }))
    await getCompanyEnrichmentProposalsFromEmails('co1', provider)

    const callArgs = provider.generateSummary.mock.calls[0]
    const userPrompt = callArgs[1] as string

    // Should include newest 30 emails (days 5–34, i.e. id email4–email34)
    // and exclude the oldest 5 (email0–email4 = days 1-5... actually days 1-5 are oldest)
    // Newest emails are email34 (day 35), email33 (day 34), ...
    // After slice(0,30): email34 down to email5
    // email0 (day 1) through email4 (day 5) should be excluded
    expect((userPrompt.match(/Email \d+ content/g) ?? []).length).toBe(30)
    // The oldest emails (0–4) should not appear
    expect(userPrompt).not.toContain('Email 0 content')
    expect(userPrompt).not.toContain('Email 1 content')
    expect(userPrompt).not.toContain('Email 2 content')
    expect(userPrompt).not.toContain('Email 3 content')
    expect(userPrompt).not.toContain('Email 4 content')
  })
})
