/**
 * Regression tests for getCompanyEnrichmentProposalsFromMeetings().
 *
 * After the EnrichmentResult refactor the function returns a discriminated
 * union instead of (proposal | null), with explicit per-failure reasons. It
 * also falls back from missing summary file → meeting.notes → Drive backup.
 *
 * Mock boundaries:
 *   - org-company.repo (getCompany, listCompanyEmails) → vi.fn() stubs
 *   - meeting.repo (getMeeting) → vi.fn() stub
 *   - file-manager (readSummary) → vi.fn() stub
 *   - google-drive (downloadSummaryFromDrive) → vi.fn() stub
 *   - custom-fields.repo (listFieldDefinitions, getFieldValuesForEntity) → vi.fn() stubs
 *   - contact.repo → vi.fn() stubs (required by same module)
 *   - company-notes.repo → vi.fn() stub (required by same module)
 *   - database/connection → stubbed (repos are mocked; DB never called)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@cyggie/db/sqlite/connection', () => ({ getDatabase: vi.fn() }))

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(),
}))

vi.mock('@cyggie/db/sqlite/repositories/company-notes.repo', () => ({
  listCompanyNotes: vi.fn(() => []),
}))

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args),
}))

const mockGetMeeting = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
}))

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args),
}))

const mockDownloadSummaryFromDrive = vi.fn()

vi.mock('../main/drive/google-drive', () => ({
  downloadSummaryFromDrive: (...args: unknown[]) => mockDownloadSummaryFromDrive(...args),
}))

const mockGetCompany = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
  listCompanyEmails: vi.fn(() => []),
}))

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
    notes: null,
    summaryDriveId: null,
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

describe('getCompanyEnrichmentProposalsFromMeetings — EnrichmentResult contract', () => {
  beforeEach(() => {
    mockGetMeeting.mockReset()
    mockReadSummary.mockReset()
    mockDownloadSummaryFromDrive.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
    mockDownloadSummaryFromDrive.mockResolvedValue(null)
  })

  it('returns no_content when meetingIds is empty', async () => {
    const result = await getCompanyEnrichmentProposalsFromMeetings([], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns no_content when all sources (summary file, notes, Drive) are empty', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('')
    mockDownloadSummaryFromDrive.mockResolvedValue(null)
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns company_not_found when content present but company lookup fails', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Some meeting content.')
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'company_not_found' })
  })

  it('returns ok with proposal when LLM extracts new meeting data', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting about Acme Corp.')
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1',
      makeProvider(JSON.stringify({ description: 'AI-powered analytics platform' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes).toHaveLength(1)
    expect(result.proposal.changes[0].field).toBe('description')
    expect(result.proposal.changes[0].to).toBe('AI-powered analytics platform')
    expect(result.proposal.updates.description).toBe('AI-powered analytics platform')
  })

  it('sets fieldSources to the most recent meeting ID for changed built-in fields', async () => {
    mockGetMeeting.mockImplementation((mid: string) =>
      makeMeeting({ id: mid, date: `2024-0${mid.slice(-1)}-01T00:00:00Z`, summaryPath: `summary-${mid}.md` })
    )
    mockReadSummary.mockReturnValue('Meeting notes.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1', 'meet2'], 'co1',
      makeProvider(JSON.stringify({ description: 'New description' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sources = JSON.parse(result.proposal.updates.fieldSources!) as Record<string, string>
    expect(sources.description).toBe('meet2')
  })

  // ─── Fix B: meeting.notes column fallback ─────────────────────────────────

  it('falls back to meeting.notes when summary file is missing', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ notes: 'Bullet notes — CAC $2, repeat 35%.' }))
    mockReadSummary.mockReturnValue(null)
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = makeProvider(JSON.stringify({ description: 'D2C brand with low CAC' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes[0].to).toBe('D2C brand with low CAC')
    // Ensure the notes content reached the prompt
    expect(provider.generateSummary).toHaveBeenCalled()
    const userPrompt = provider.generateSummary.mock.calls[0]![1] as string
    expect(userPrompt).toContain('CAC $2, repeat 35%')
  })

  it('prefers summary file content over meeting.notes when both exist', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ notes: 'Bullet stub' }))
    mockReadSummary.mockReturnValue('Full prose AI summary about the company.')
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = makeProvider(JSON.stringify({ description: 'Whatever' }))
    await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    const userPrompt = provider.generateSummary.mock.calls[0]![1] as string
    expect(userPrompt).toContain('Full prose AI summary about the company.')
    expect(userPrompt).not.toContain('Bullet stub')
  })

  // ─── Fix D: Drive backup fallback ─────────────────────────────────────────

  it('falls back to Drive download when summary file missing and notes empty', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ notes: null, summaryDriveId: 'drive-id-1' }))
    mockReadSummary.mockReturnValue(null)
    mockDownloadSummaryFromDrive.mockResolvedValue('Drive-restored summary content.')
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = makeProvider(JSON.stringify({ description: 'Recovered from Drive' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(mockDownloadSummaryFromDrive).toHaveBeenCalledWith('drive-id-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes[0].to).toBe('Recovered from Drive')
  })

  it('skips Drive download when notes already filled the content slot', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting({ notes: 'Has bullet notes', summaryDriveId: 'drive-id-1' }))
    mockReadSummary.mockReturnValue(null)
    mockGetCompany.mockReturnValue(makeCompany())
    await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', makeProvider('{}'))
    expect(mockDownloadSummaryFromDrive).not.toHaveBeenCalled()
  })

  // ─── Fix E: LLM-side failure reasons ──────────────────────────────────────

  it('returns llm_failed when provider.generateSummary throws', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting content.')
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result).toEqual({ ok: false, reason: 'llm_failed' })
  })

  it('returns parse_failed when LLM returns non-JSON', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting content.')
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1', makeProvider('this is not json at all')
    )
    expect(result).toEqual({ ok: false, reason: 'parse_failed' })
  })

  // ─── Fix C: empty proposal instead of null for no-changes ─────────────────

  it('returns ok with empty changes when LLM finds nothing new', async () => {
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Meeting content.')
    mockGetCompany.mockReturnValue(makeCompany({ description: 'Existing description' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(
      ['meet1'], 'co1',
      makeProvider(JSON.stringify({ description: 'Existing description' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes).toEqual([])
    expect(result.proposal.updates).toEqual({})
  })
})
