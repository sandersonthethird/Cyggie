/**
 * Tests for getCompanyEnrichmentProposalsFromNotes() in company-summary-sync.service.ts
 *
 * Mock boundaries:
 *   - notes-base.makeEntityNotesRepo → returns a stub whose `list()` is
 *     controlled by mockListCompanyNotes. (Production builds the company
 *     notes repo via makeEntityNotesRepo('company_id') at module load.)
 *   - org-company.repo (getCompany) → vi.fn() stub
 *   - custom-fields.repo (listFieldDefinitions, getFieldValuesForEntity) → vi.fn() stubs
 *   - contact.repo → vi.fn() stubs (required by same module)
 *   - meeting.repo → vi.fn() stub (required by same module)
 *   - file-manager → vi.fn() stub (required by same module)
 *   - database/connection → stubbed (repos are mocked; DB never called)
 *
 * The LLM provider is injected directly, so no module-level mock needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { notesBaseMockFactory } from './_fixtures/test-db'

vi.mock('@cyggie/db/sqlite/connection', () => ({ getDatabase: vi.fn() }))

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(),
}))

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: vi.fn(),
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
}))

vi.mock('../main/drive/google-drive', () => ({
  downloadSummaryFromDrive: vi.fn(),
}))

const mockListCompanyNotes = vi.fn()

// Production builds the company notes repo via makeEntityNotesRepo at module
// load. Shared helper in _fixtures/test-db.ts forwards .list() to the mock.
vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => notesBaseMockFactory(mockListCompanyNotes))

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args),
}))

const mockGetCompany = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
  listCompanyEmails: vi.fn(() => []),
}))

const { getCompanyEnrichmentProposalsFromNotes } = await import(
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

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note1',
    title: 'Intro call notes',
    content: 'Acme Corp is building an AI analytics platform.',
    companyId: 'co1',
    contactId: null,
    sourceMeetingId: null,
    themeId: null,
    isPinned: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
    folderPath: null,
    importSource: null,
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

describe('getCompanyEnrichmentProposalsFromNotes', () => {
  beforeEach(() => {
    mockListCompanyNotes.mockReset()
    mockGetCompany.mockReset()
    mockListFieldDefinitions.mockReset()
    mockGetFieldValuesForEntity.mockReset()

    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
  })

  it('returns no_content when companyId is empty string', async () => {
    const result = await getCompanyEnrichmentProposalsFromNotes('', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns no_content when all notes have empty content', async () => {
    mockListCompanyNotes.mockReturnValue([
      makeNote({ content: '' }),
      makeNote({ content: '   ' }),
    ])
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'no_content' })
  })

  it('returns company_not_found when company lookup fails', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider())
    expect(result).toEqual({ ok: false, reason: 'company_not_found' })
  })

  it('returns llm_failed when LLM throws', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', provider)
    expect(result).toEqual({ ok: false, reason: 'llm_failed' })
  })

  it('returns parse_failed when LLM response is not parseable JSON', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider('not valid json'))
    expect(result).toEqual({ ok: false, reason: 'parse_failed' })
  })

  it('returns ok with empty changes when LLM response has no field changes vs current values', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany({ description: 'Existing description' }))
    const result = await getCompanyEnrichmentProposalsFromNotes(
      'co1',
      makeProvider(JSON.stringify({ description: 'Existing description' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes).toEqual([])
    expect(result.proposal.updates).toEqual({})
  })

  it('returns ok with proposal when LLM extracts new values', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromNotes(
      'co1',
      makeProvider(JSON.stringify({ description: 'AI-powered analytics platform' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.companyId).toBe('co1')
    expect(result.proposal.changes).toHaveLength(1)
    expect(result.proposal.changes[0].field).toBe('description')
    expect(result.proposal.changes[0].to).toBe('AI-powered analytics platform')
    expect(result.proposal.updates.description).toBe('AI-powered analytics platform')
  })

  it('does NOT set fieldSources in proposal updates', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromNotes(
      'co1',
      makeProvider(JSON.stringify({ description: 'New description' }))
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.updates.fieldSources).toBeUndefined()
  })

  it('sorts notes oldest-to-newest before building prompt', async () => {
    const older = makeNote({ id: 'note1', createdAt: '2024-01-01T00:00:00Z', content: 'Older note content.' })
    const newer = makeNote({ id: 'note2', createdAt: '2024-06-01T00:00:00Z', content: 'Newer note content.' })
    // Return newer first to confirm sorting is applied by service
    mockListCompanyNotes.mockReturnValue([newer, older])
    mockGetCompany.mockReturnValue(makeCompany())

    const provider = makeProvider(JSON.stringify({ description: 'Sorted' }))
    await getCompanyEnrichmentProposalsFromNotes('co1', provider)

    const callArgs = provider.generateSummary.mock.calls[0]
    const userPrompt = callArgs[1] as string
    const olderPos = userPrompt.indexOf('2024-01-01')
    const newerPos = userPrompt.indexOf('2024-06-01')
    expect(olderPos).toBeGreaterThanOrEqual(0)
    expect(newerPos).toBeGreaterThanOrEqual(0)
    expect(olderPos).toBeLessThan(newerPos)
  })
})
