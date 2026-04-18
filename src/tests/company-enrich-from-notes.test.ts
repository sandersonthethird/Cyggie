/**
 * Tests for getCompanyEnrichmentProposalsFromNotes() in company-summary-sync.service.ts
 *
 * Mock boundaries:
 *   - company-notes.repo (listCompanyNotes) → vi.fn() stub
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

const mockListCompanyNotes = vi.fn()

vi.mock('../main/database/repositories/company-notes.repo', () => ({
  listCompanyNotes: (...args: unknown[]) => mockListCompanyNotes(...args),
}))

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args),
}))

const mockGetCompany = vi.fn()

vi.mock('../main/database/repositories/org-company.repo', () => ({
  getCompany: (...args: unknown[]) => mockGetCompany(...args),
  getAllCompanies: vi.fn(() => []),
  searchCompanies: vi.fn(() => []),
  updateCompany: vi.fn(),
  listCompanyEmails: vi.fn(() => []),
}))

const { getCompanyEnrichmentProposalsFromNotes } = await import(
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

  it('returns null when companyId is empty string', async () => {
    const result = await getCompanyEnrichmentProposalsFromNotes('', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when all notes have empty content', async () => {
    mockListCompanyNotes.mockReturnValue([
      makeNote({ content: '' }),
      makeNote({ content: '   ' }),
    ])
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when company not found', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(null)
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider())
    expect(result).toBeNull()
  })

  it('returns null when LLM throws', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const provider = { generateSummary: vi.fn().mockRejectedValue(new Error('LLM timeout')) }
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', provider)
    expect(result).toBeNull()
  })

  it('returns null when safeParseJson returns null', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromNotes('co1', makeProvider('not valid json'))
    expect(result).toBeNull()
  })

  it('returns null when LLM response has no field changes vs current values', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany({ description: 'Existing description' }))
    const result = await getCompanyEnrichmentProposalsFromNotes(
      'co1',
      makeProvider(JSON.stringify({ description: 'Existing description' }))
    )
    expect(result).toBeNull()
  })

  it('returns proposal with changes when LLM extracts new values', async () => {
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany({ description: null }))
    const result = await getCompanyEnrichmentProposalsFromNotes(
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
    mockListCompanyNotes.mockReturnValue([makeNote()])
    mockGetCompany.mockReturnValue(makeCompany())
    const result = await getCompanyEnrichmentProposalsFromNotes(
      'co1',
      makeProvider(JSON.stringify({ description: 'New description' }))
    )
    expect(result).not.toBeNull()
    expect(result!.updates.fieldSources).toBeUndefined()
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
