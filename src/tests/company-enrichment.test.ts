/**
 * Tests for getCompanyEnrichmentProposalsFromMeetings() in company-summary-sync.service.ts
 *
 * Mock boundaries:
 *   - org-company.repo (getCompany) → vi.fn() stub
 *   - meeting.repo (getMeeting) → vi.fn() stub
 *   - file-manager (readSummary) → vi.fn() stub
 *   - custom-fields.repo (listFieldDefinitions, getFieldValuesForEntity) → vi.fn() stubs
 *   - contact.repo → vi.fn() stubs (required by same module)
 *   - database/connection → in-memory SQLite
 *
 * The LLM provider is injected directly, so no module-level mock needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock: database connection ────────────────────────────────────────────────
// All repo functions are mocked, so getDatabase is never called.

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn()
}))

// ─── Mock: contact repo ───────────────────────────────────────────────────────

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn()
}))

// ─── Mock: custom-fields repo ─────────────────────────────────────────────────

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args)
}))

// ─── Mock: meeting repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args)
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args)
}))

// ─── Mock: org-company repo ───────────────────────────────────────────────────

const mockGetCompany = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  // Other exports used by the service (stubs)
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
}))

// ─── Import service under test (after mocks) ─────────────────────────────────

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

describe('getCompanyEnrichmentProposalsFromMeetings', () => {
  beforeEach(() => {
    mockGetMeeting.mockReset()
    mockReadSummary.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    // Default: no custom fields
    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
  })

  it('returns null for empty meetingIds array', async () => {
    const result = await getCompanyEnrichmentProposalsFromMeetings([], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when meeting not found', async () => {
    mockGetMeeting.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when meeting has no summaryFilename', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ summaryFilename: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when summary file is empty', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when company not found', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when LLM returns malformed JSON', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider('not valid json')
    )
    expect(result).toBeNull()
  })

  it('returns null when LLM response has no changes vs current values', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: 'Existing description' }))
    // LLM returns same description as current
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider(JSON.stringify({ description: 'Existing description' }))
    )
    expect(result).toBeNull()
  })

  it('returns a proposal when LLM detects a changed field', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider(JSON.stringify({ description: 'AI-powered analytics' }))
    )
    expect(result).not.toBeNull()
    expect(result!.companyId).toBe('co1')
    expect(result!.changes).toHaveLength(1)
    expect(result!.changes[0].field).toBe('description')
    expect(result!.changes[0].to).toBe('AI-powered analytics')
    expect(result!.updates.description).toBe('AI-powered analytics')
  })

  it('sets fieldSources to the most recent meeting ID for built-in fields', async () => {
    mockGetMeeting.mockImplementation((mid: string) => makeMeeting({ id: mid, summaryFilename: `summary-${mid}.md` }))
    mockReadSummary.mockReturnValue('Meeting notes.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1', 'meet2'], 'co1',
      makeProvider(JSON.stringify({ description: 'New description', round: 'seed' }))
    )
    expect(result).not.toBeNull()
    const sources = JSON.parse(result!.updates.fieldSources!) as Record<string, string>
    // All field source values should be a meetingId string
    expect(Object.keys(sources).length).toBeGreaterThan(0)
    expect(Object.values(sources).every(v => typeof v === 'string' && v.startsWith('meet'))).toBe(true)
  })

  it('returns null when LLM throws', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result).toBeNull()
  })

  it('includes customFieldUpdates when LLM provides a value for a custom field', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme.')
    mockGetCompany.mockReturnValue(makeCompany())
    mockListFieldDefinitions.mockReturnValue([{
      id: 'fd1',
      label: 'Sector',
      fieldKey: 'sector',
      fieldType: 'text',
      isBuiltin: false,
      entityType: 'company',
    }])
    mockGetFieldValuesForEntity.mockReturnValue([])
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1',
      makeProvider(JSON.stringify({ description: 'Corp', sector: 'Fintech' }))
    )
    expect(result).not.toBeNull()
    expect(result!.customFieldUpdates).toHaveLength(1)
    expect(result!.customFieldUpdates![0].fieldDefinitionId).toBe('fd1')
    expect(result!.customFieldUpdates![0].toDisplay).toBe('Fintech')
  })
})
