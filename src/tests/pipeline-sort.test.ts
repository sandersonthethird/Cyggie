import { describe, it, expect } from 'vitest'
import { sortCompanies } from '../renderer/routes/Pipeline'
import type { CompanySummary } from '../shared/types/company'

function company(overrides: Partial<CompanySummary>): CompanySummary {
  return {
    id: 'x',
    canonicalName: 'X',
    normalizedName: 'x',
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
    meetingCount: 0,
    emailCount: 0,
    noteCount: 0,
    contactCount: 0,
    lastTouchpoint: null,
    priority: null,
    postMoneyValuation: null,
    raiseSize: null,
    round: null,
    pipelineStage: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as CompanySummary
}

describe('sortCompanies', () => {
  it('sorts by name alphabetically asc', () => {
    const result = sortCompanies(
      [company({ id: '1', canonicalName: 'Zebra' }), company({ id: '2', canonicalName: 'Apple' })],
      'name', 'asc'
    )
    expect(result.map(c => c.canonicalName)).toEqual(['Apple', 'Zebra'])
  })

  it('sorts by name alphabetically desc', () => {
    const result = sortCompanies(
      [company({ id: '1', canonicalName: 'Apple' }), company({ id: '2', canonicalName: 'Zebra' })],
      'name', 'desc'
    )
    expect(result.map(c => c.canonicalName)).toEqual(['Zebra', 'Apple'])
  })

  it('sorts by stage in enum order (screening < diligence < decision < documentation < pass)', () => {
    const input = [
      company({ id: '1', pipelineStage: 'pass' }),
      company({ id: '2', pipelineStage: 'screening' }),
      company({ id: '3', pipelineStage: 'decision' }),
      company({ id: '4', pipelineStage: 'diligence' }),
      company({ id: '5', pipelineStage: 'documentation' }),
    ]
    const result = sortCompanies(input, 'stage', 'asc')
    expect(result.map(c => c.pipelineStage)).toEqual([
      'screening', 'diligence', 'decision', 'documentation', 'pass'
    ])
  })

  it('puts unknown stage value last (custom stages not in ORDER map)', () => {
    const input = [
      company({ id: '1', pipelineStage: 'custom_stage' as any }),
      company({ id: '2', pipelineStage: 'screening' }),
    ]
    const result = sortCompanies(input, 'stage', 'asc')
    expect(result[0].pipelineStage).toBe('screening')
    expect(result[1].pipelineStage).toBe('custom_stage')
  })

  it('sorts by priority in enum order (high < further_work < monitor)', () => {
    const input = [
      company({ id: '1', priority: 'monitor' }),
      company({ id: '2', priority: 'high' }),
      company({ id: '3', priority: 'further_work' }),
    ]
    const result = sortCompanies(input, 'priority', 'asc')
    expect(result.map(c => c.priority)).toEqual(['high', 'further_work', 'monitor'])
  })

  it('sorts by postMoney ascending, nulls last', () => {
    const input = [
      company({ id: '1', postMoneyValuation: 50 }),
      company({ id: '2', postMoneyValuation: null }),
      company({ id: '3', postMoneyValuation: 10 }),
    ]
    const result = sortCompanies(input, 'postMoney', 'asc')
    expect(result.map(c => c.postMoneyValuation)).toEqual([10, 50, null])
  })

  it('sorts by postMoney descending, nulls still last', () => {
    const input = [
      company({ id: '1', postMoneyValuation: 10 }),
      company({ id: '2', postMoneyValuation: null }),
      company({ id: '3', postMoneyValuation: 50 }),
    ]
    const result = sortCompanies(input, 'postMoney', 'desc')
    expect(result.map(c => c.postMoneyValuation)).toEqual([50, 10, null])
  })

  it('sorts by raiseSize ascending, nulls last', () => {
    const input = [
      company({ id: '1', raiseSize: 5 }),
      company({ id: '2', raiseSize: null }),
      company({ id: '3', raiseSize: 2 }),
    ]
    const result = sortCompanies(input, 'raiseSize', 'asc')
    expect(result.map(c => c.raiseSize)).toEqual([2, 5, null])
  })

  it('reverses non-null values when direction toggles but keeps nulls last', () => {
    const asc = sortCompanies([
      company({ id: '1', raiseSize: 10 }),
      company({ id: '2', raiseSize: 5 }),
      company({ id: '3', raiseSize: null }),
    ], 'raiseSize', 'asc')
    expect(asc.map(c => c.raiseSize)).toEqual([5, 10, null])

    const desc = sortCompanies([
      company({ id: '1', raiseSize: 5 }),
      company({ id: '2', raiseSize: 10 }),
      company({ id: '3', raiseSize: null }),
    ], 'raiseSize', 'desc')
    expect(desc.map(c => c.raiseSize)).toEqual([10, 5, null])
  })

  it('returns a new array and does not mutate input', () => {
    const input = [
      company({ id: '1', canonicalName: 'Zebra' }),
      company({ id: '2', canonicalName: 'Apple' }),
    ]
    const originalOrder = input.map(c => c.canonicalName)
    sortCompanies(input, 'name', 'asc')
    expect(input.map(c => c.canonicalName)).toEqual(originalOrder)
  })
})
