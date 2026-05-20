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

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn()
}))

// ─── Mock: contact repo ───────────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn()
}))

// ─── Mock: custom-fields repo ─────────────────────────────────────────────────

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args)
}))

// ─── Mock: meeting repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args)
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args)
}))

// ─── Mock: google-drive (downloadSummaryFromDrive) ────────────────────────────

const mockDownloadSummaryFromDrive = vi.fn()

vi.mock('../main/drive/google-drive', () => ({
  downloadSummaryFromDrive: (...args: unknown[]) => mockDownloadSummaryFromDrive(...args),
}))

// ─── Mock: org-company repo ───────────────────────────────────────────────────

const mockGetCompany = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  // Other exports used by the service (stubs)
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
}))

// ─── Import service under test (after mocks) ─────────────────────────────────

const { getCompanyEnrichmentProposalsFromMeetings } = await import(
  '@cyggie/services/company-summary-sync.service'
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
    summaryPath: 'summary-meet1.md',
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
    mockDownloadSummaryFromDrive.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    // Default: no custom fields
    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
    mockDownloadSummaryFromDrive.mockResolvedValue(null)
  })

  it('returns no_content for empty meetingIds array', async () => {
    const result = await getCompanyEnrichmentProposalsFromMeetings([], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns no_content when meeting not found', async () => {
    mockGetMeeting.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns no_content when meeting has no summary, no notes, no Drive ID', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ summaryPath: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns no_content when summary file is empty and no fallbacks', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns company_not_found when content present but company missing', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'company_not_found' })
  })

  it('returns parse_failed when LLM returns malformed JSON', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider('not valid json')
    )
    expect(result).toEqual({ ok: false, reason: 'parse_failed' })
  })

  it('returns ok with empty changes when LLM response has no changes vs current values', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: 'Existing description' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider(JSON.stringify({ description: 'Existing description' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes).toEqual([])
  })

  it('returns ok with proposal when LLM detects a changed field', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider(JSON.stringify({ description: 'AI-powered analytics' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.companyId).toBe('co1')
    expect(result.proposal.changes).toHaveLength(1)
    expect(result.proposal.changes[0].field).toBe('description')
    expect(result.proposal.changes[0].to).toBe('AI-powered analytics')
    expect(result.proposal.updates.description).toBe('AI-powered analytics')
  })

  it('sets fieldSources to the most recent meeting ID for built-in fields', async () => {
    mockGetMeeting.mockImplementation((mid: string) => makeMeeting({ id: mid, summaryPath: `summary-${mid}.md` }))
    mockReadSummary.mockReturnValue('Meeting notes.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1', 'meet2'], 'co1',
      makeProvider(JSON.stringify({ description: 'New description', round: 'seed' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sources = JSON.parse(result.proposal.updates.fieldSources!) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThan(0)
    expect(Object.values(sources).every(v => typeof v === 'string' && v.startsWith('meet'))).toBe(true)
  })

  it('returns llm_failed when LLM throws', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result).toEqual({ ok: false, reason: 'llm_failed' })
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
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.customFieldUpdates).toHaveLength(1)
    expect(result.proposal.customFieldUpdates![0].fieldDefinitionId).toBe('fd1')
    expect(result.proposal.customFieldUpdates![0].toDisplay).toBe('Fintech')
  })
})
