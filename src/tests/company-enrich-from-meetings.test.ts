/**
 * Regression tests for getCompanyEnrichmentProposalsFromMeetings() after the
 * buildCompanyEnrichmentProposal extraction refactor.
 *
 * These guard against regressions introduced when the diff logic was moved to
 * the shared buildCompanyEnrichmentProposal helper.
 *
 * Mock boundaries:
 *   - org-company.repo (getCompany, listCompanyEmails) → vi.fn() stubs
 *   - meeting.repo (getMeeting) → vi.fn() stub
 *   - file-manager (readSummary) → vi.fn() stub
 *   - custom-fields.repo (listFieldDefinitions, getFieldValuesForEntity) → vi.fn() stubs
 *   - contact.repo → vi.fn() stubs (required by same module)
 *   - company-notes.repo → vi.fn() stub (required by same module)
 *   - database/connection → stubbed (repos are mocked; DB never called)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../main/database/connection', () => ({ getDatabase: vi.fn() }))

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(),
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

const mockGetMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
}))

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args),
}))

const mockGetCompany = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
  listCompanyEmails: vi.fn(() => []),
}))

const { getCompanyEnrichmentProposalsFromMeetings } = await import(
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

function makeMeeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'meet1',
    date: '2024-01-15T10:00:00Z',
    summaryFilename: 'summary-meet1.md',
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

describe('getCompanyEnrichmentProposalsFromMeetings — regression after extraction', () => {
  beforeEach(() => {
    mockGetMeeting.mockReset()
    mockReadSummary.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
  })

  it('returns null when meetingIds is empty', async () => {
    const result = await getCompanyEnrichmentProposalsFromMeetings([], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when all summary files are empty or missing', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when company not found', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Some meeting content.')
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns proposal with changes when LLM extracts new meeting data', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1',
      makeProvider(JSON.stringify({ description: 'AI-powered analytics platform' }))
    )
    expect(result).not.toBeNull()
    expect(result!.changes).toHaveLength(1)
    expect(result!.changes[0].field).toBe('description')
    expect(result!.changes[0].to).toBe('AI-powered analytics platform')
    expect(result!.updates.description).toBe('AI-powered analytics platform')
  })

  it('sets fieldSources to the most recent meeting ID for changed built-in fields', async () => {
    mockGetMeeting.mockImplementation((mid: string) =>
      makeMeeting({ id: mid, date: `2024-0${mid.slice(-1)}-01T00:00:00Z`, summaryFilename: `summary-${mid}.md` })
    )
    mockReadSummary.mockReturnValue('Meeting notes.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1', 'meet2'], 'co1',
      makeProvider(JSON.stringify({ description: 'New description' }))
    )
    expect(result).not.toBeNull()
    const sources = JSON.parse(result!.updates.fieldSources!) as Record<string, string>
    expect(sources.description).toBe('meet2')
  })
})
