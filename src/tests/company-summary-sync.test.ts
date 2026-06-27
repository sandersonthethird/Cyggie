/**
 * Tests for getVcSummaryCompanyUpdateProposals() in company-summary-sync.service.ts.
 *
 * The function previously used regex extraction that hallucinated round/post-money
 * values. It now delegates to buildCompanyEnrichmentProposal() which calls an LLM.
 * These tests verify the plumbing with a stub LLMProvider; real-LLM behaviour
 * (prompt quality, hallucination suppression) is covered by the on-demand
 * eval at src/tests/evals/company-extraction.eval.ts.
 */

import { describe, it, expect, vi } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn()
}))

const listMeetingCompaniesMock = vi.fn()
const getCompanyMock = vi.fn()
const listCompanyMeetingsMock = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  listMeetingCompanies: (...args: unknown[]) => listMeetingCompaniesMock(...args),
  getCompany: (...args: unknown[]) => getCompanyMock(...args),
  listCompanyMeetings: (...args: unknown[]) => listCompanyMeetingsMock(...args)
}))

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({}))
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(() => ({}))
}))
vi.mock('@cyggie/db/sqlite/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: () => [],
  getFieldValuesForEntity: () => []
}))
vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({ list: () => [] })
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn()
}))
vi.mock('../main/drive/google-drive', () => ({
  downloadSummaryFromDrive: vi.fn()
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import { getVcSummaryCompanyUpdateProposals } from '@cyggie/services/company-summary-sync.service'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import type { CompanyDetail, CompanySummary } from '../shared/types/company'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCompanySummary(overrides: Partial<CompanySummary> = {}): CompanySummary {
  return {
    id: 'co-1',
    canonicalName: 'Acme',
    normalizedName: 'acme',
    description: null,
    primaryDomain: null,
    websiteUrl: null,
    city: null,
    state: null,
    stage: null,
    status: 'active',
    crmProvider: null,
    crmCompanyId: null,
    entityType: 'prospect',
    includeInCompaniesView: true,
    classificationSource: 'manual',
    classificationConfidence: null,
    meetingCount: 1,
    emailCount: 0,
    noteCount: 0,
    contactCount: 0,
    lastTouchpoint: null,
    priority: null,
    postMoneyValuation: null,
    raiseSize: null,
    round: null,
    pipelineStage: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    foundingYear: null,
    employeeCountRange: null,
    linkedinCompanyUrl: null,
    twitterHandle: null,
    crunchbaseUrl: null,
    angellistUrl: null,
    industry: null,
    targetCustomer: null,
    businessModel: null,
    ...overrides
  } as CompanySummary
}

function makeCompanyDetail(overrides: Partial<CompanyDetail> = {}): CompanyDetail {
  return {
    ...makeCompanySummary(),
    notes: null,
    fieldSources: null,
    ...overrides
  } as CompanyDetail
}

function makeProvider(response: string | (() => Promise<string>)): LLMProvider {
  const generateSummary = vi.fn().mockImplementation(
    typeof response === 'string' ? async () => response : response
  )
  return { generateSummary } as unknown as LLMProvider
}

const SAMPLE_SUMMARY =
  '## Executive Summary\n\nAcme builds AI tools, raising a $5M seed. ' +
  'Comparable company FooCo recently closed a Series A at $30M post-money valuation.\n'

// Make isFirstMeetingForCompany() return true: company has exactly one meeting
// matching the meetingId we pass to getVcSummaryCompanyUpdateProposals.
function setUpSingleProspect(meetingId: string, company: CompanySummary): CompanyDetail {
  listMeetingCompaniesMock.mockReturnValue([company])
  listCompanyMeetingsMock.mockReturnValue([{ id: meetingId }])
  const detail = makeCompanyDetail({ ...company } as Partial<CompanyDetail>)
  getCompanyMock.mockReturnValue(detail)
  return detail
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getVcSummaryCompanyUpdateProposals — LLM-driven extraction', () => {
  it('only proposes grounded fields when LLM returns null for non-grounded ones', async () => {
    const meetingId = 'm-1'
    setUpSingleProspect(meetingId, makeCompanySummary())

    // LLM returns null for everything the summary doesn't explicitly state for
    // Acme, even though "Series A" and "$30M post-money" appear in comp context.
    const provider = makeProvider(JSON.stringify({
      description: 'Acme builds AI tools.',
      round: null,
      raiseSize: 5,
      postMoneyValuation: null,
      city: null,
      state: null,
      pipelineStage: null,
      industry: null
    }))

    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )

    expect(proposals).toHaveLength(1)
    const fields = proposals[0]!.changes.map((c) => c.field)
    expect(fields).toContain('description')
    expect(fields).toContain('raiseSize')
    expect(fields).not.toContain('round')
    expect(fields).not.toContain('postMoneyValuation')
  })

  it('does not propose changes when LLM returns all null', async () => {
    const meetingId = 'm-2'
    setUpSingleProspect(meetingId, makeCompanySummary())

    const provider = makeProvider(JSON.stringify({
      description: null,
      round: null,
      raiseSize: null,
      postMoneyValuation: null,
      city: null,
      state: null,
      pipelineStage: null,
      industry: null
    }))

    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )

    expect(proposals).toEqual([])
  })

  it('routes a sector value to the industry field', async () => {
    const meetingId = 'm-industry'
    setUpSingleProspect(meetingId, makeCompanySummary())

    const provider = makeProvider(JSON.stringify({
      description: null, round: null, raiseSize: null, postMoneyValuation: null,
      city: null, state: null, pipelineStage: null,
      industry: 'LegalTech'
    }))

    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )

    const industryChange = proposals[0]!.changes.find((c) => c.field === 'industry')
    expect(industryChange?.to).toBe('LegalTech')
  })

  it('drops a non-canonical pipelineStage value (e.g. a sector leaked into it)', async () => {
    const meetingId = 'm-bad-stage'
    setUpSingleProspect(meetingId, makeCompanySummary())

    // Defense-in-depth: even if the model puts "LegalTech" in pipelineStage,
    // the canonical-stage validation must drop it rather than propose it.
    const provider = makeProvider(JSON.stringify({
      description: null, round: null, raiseSize: null, postMoneyValuation: null,
      city: null, state: null,
      pipelineStage: 'LegalTech',
      industry: null
    }))

    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )

    const fields = (proposals[0]?.changes ?? []).map((c) => c.field)
    expect(fields).not.toContain('pipelineStage')
  })

  it('returns empty array when LLM call throws', async () => {
    const meetingId = 'm-3'
    setUpSingleProspect(meetingId, makeCompanySummary())

    const provider = makeProvider(async () => { throw new Error('boom') })
    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )
    expect(proposals).toEqual([])
  })

  it('returns empty array when LLM returns invalid JSON', async () => {
    const meetingId = 'm-4'
    setUpSingleProspect(meetingId, makeCompanySummary())

    const provider = makeProvider('not valid json at all')
    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )
    expect(proposals).toEqual([])
  })

  it('returns empty array when no prospect company is linked to the meeting', async () => {
    listMeetingCompaniesMock.mockReturnValue([])
    const provider = makeProvider('{}')
    const proposals = await getVcSummaryCompanyUpdateProposals(
      'm-5', SAMPLE_SUMMARY, undefined, provider
    )
    expect(proposals).toEqual([])
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })

  it('skips non-prospect entities (e.g. existing portfolio companies)', async () => {
    const meetingId = 'm-6'
    listMeetingCompaniesMock.mockReturnValue([
      makeCompanySummary({ entityType: 'startup' })
    ])
    const provider = makeProvider('{}')
    const proposals = await getVcSummaryCompanyUpdateProposals(
      meetingId, SAMPLE_SUMMARY, undefined, provider
    )
    expect(proposals).toEqual([])
  })

  it('skips when summary is empty', async () => {
    const provider = makeProvider('{}')
    const proposals = await getVcSummaryCompanyUpdateProposals(
      'm-7', '   ', undefined, provider
    )
    expect(proposals).toEqual([])
    expect(provider.generateSummary).not.toHaveBeenCalled()
  })
})
