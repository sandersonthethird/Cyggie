/**
 * Regression tests for extractDescription() in company-summary-sync.service.ts.
 *
 * extractDescription() is a pure text-parsing function but lives in a module
 * that imports repos and file-manager. All module dependencies are mocked so the
 * function can be tested without a database.
 *
 * Guards the subLabel ?? [existing logic] fallback path introduced when
 * extractDescriptionSubLabel() was added.
 */

import { describe, it, expect, vi } from 'vitest'

// ─── Mock: database connection ────────────────────────────────────────────────

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn()
}))

// ─── Mock: repos ──────────────────────────────────────────────────────────────

vi.mock('../main/database/repositories/org-company.repo', () => ({}))
vi.mock('../main/database/repositories/meeting.repo', () => ({}))
vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn()
}))
vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: vi.fn(),
  getFieldValuesForEntity: vi.fn()
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn()
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

import { extractDescription, buildProposalForCompany } from '../main/services/company-summary-sync.service'
import type { CompanySummary } from '../shared/types/company'
import type { ParsedVcSummaryFields } from '../main/services/company-summary-sync.service'

// Minimal company stub — only fields checked inside buildProposalForCompany
function makeCompany(overrides: Partial<CompanySummary> = {}): CompanySummary {
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
    entityType: 'startup',
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
    hqAddress: null,
    linkedinCompanyUrl: null,
    twitterHandle: null,
    crunchbaseUrl: null,
    angellistUrl: null,
    sector: null,
    targetCustomer: null,
    businessModel: null,
    ...overrides,
  } as CompanySummary
}

// Minimal parsed fields stub
function makeParsed(overrides: Partial<ParsedVcSummaryFields> = {}): ParsedVcSummaryFields {
  return {
    description: null,
    round: null,
    raiseSize: null,
    postMoneyValuation: null,
    city: null,
    state: null,
    pipelineStage: null,
    ...overrides,
  }
}

describe('buildProposalForCompany — financial sanity check', () => {
  it('rejects a $2000M raise for a pre_seed company', () => {
    const company = makeCompany({ round: 'pre_seed' })
    const parsed = makeParsed({ raiseSize: 2000, postMoneyValuation: 2000 })
    const proposal = buildProposalForCompany(company, parsed)
    // Both values exceed pre_seed limits — no financial changes should be proposed
    const fields = proposal?.changes.map((c) => c.field) ?? []
    expect(fields).not.toContain('raiseSize')
    expect(fields).not.toContain('postMoneyValuation')
  })

  it('accepts a $2M raise for a pre_seed company', () => {
    const company = makeCompany({ round: 'pre_seed' })
    const parsed = makeParsed({ raiseSize: 2, postMoneyValuation: 10 })
    const proposal = buildProposalForCompany(company, parsed)
    const fields = proposal?.changes.map((c) => c.field) ?? []
    expect(fields).toContain('raiseSize')
    expect(fields).toContain('postMoneyValuation')
  })

  it('passes through any raise when round is null', () => {
    const company = makeCompany({ round: null })
    const parsed = makeParsed({ raiseSize: 2000, postMoneyValuation: 2000 })
    const proposal = buildProposalForCompany(company, parsed)
    const fields = proposal?.changes.map((c) => c.field) ?? []
    expect(fields).toContain('raiseSize')
    expect(fields).toContain('postMoneyValuation')
  })

  it('uses the company stored round when no new round is extracted', () => {
    // Company has pre_seed stored, meeting didn't extract a new round
    const company = makeCompany({ round: 'pre_seed' })
    const parsed = makeParsed({ round: null, raiseSize: 2000 })
    const proposal = buildProposalForCompany(company, parsed)
    const fields = proposal?.changes.map((c) => c.field) ?? []
    // Should be blocked by the stored pre_seed limit
    expect(fields).not.toContain('raiseSize')
  })
})

describe('extractDescription — fallback behavior', () => {
  it('returns the first sentence of Executive Summary when no Description sub-label exists', () => {
    const note = `
## Executive Summary

Acme builds AI-powered tools for enterprise sales teams. Founded by Jane Smith, raising $3M. We recommend passing.

## Investment Highlights

- Strong team
`
    expect(extractDescription(note)).toBe('Acme builds AI-powered tools for enterprise sales teams.')
  })
})
