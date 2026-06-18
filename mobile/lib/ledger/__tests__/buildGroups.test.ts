import { describe, expect, it } from 'vitest'
import { buildCompanyGroups, buildContactGroups, type LedgerDetail } from '../buildGroups'
import type { LedgerGroup } from '../../../components/LedgerCard'

const sectionLabels = (g: LedgerGroup[]) => g.map((x) => x.label)
const row = (g: LedgerGroup[], section: string, key: string) =>
  g.find((x) => x.label === section)?.rows.find((r) => r.key === key)

const company: LedgerDetail = {
  id: 'c1',
  name: 'Amma',
  industry: 'AI Infra, Dev Tools',
  stage: 'growth',
  pipelineStage: 'due_diligence',
  employeeCountRange: '11-50',
  foundingYear: 2023,
  city: 'San Francisco',
  state: 'CA',
  round: 'pre_seed',
  raiseSize: 2,
  postMoneyValuation: 10,
  arr: 1_800_000,
  runwayMonths: 11,
  totalFundingRaised: 5_000_000,
  leadInvestor: 'Sequoia',
  coInvestors: ['a16z', 'Index'],
  portfolioFund: 'fund_iv',
  investmentSize: '500000',
  ownershipPct: '5%',
  investmentMark: 2.5,
  initialInvestmentSecurity: 'safe',
  dateOfInitialInvestment: '2026-04-14T00:00:00Z',
  websiteUrl: 'https://www.amma.ai',
  linkedinCompanyUrl: 'https://www.linkedin.com/company/amma/',
  // structural / intentionally hidden — must NOT appear:
  status: 'active',
  entityType: 'unknown',
  description: 'a description',
  keyTakeaways: 'bullets',
  recentMeetings: [{ id: 'm1' }],
  people: [{ id: 'p1' }],
  // a genuinely new field — must surface under MORE:
  secretSauce: 'umami',
}

describe('buildCompanyGroups', () => {
  const g = buildCompanyGroups(company)

  it('emits sections in registry order, MORE last', () => {
    expect(sectionLabels(g)).toEqual(['OVERVIEW', 'FINANCIALS', 'INVESTMENT', 'LINKS', 'MORE'])
  })

  it('renders Industry as one violet pill per token', () => {
    const r = row(g, 'OVERVIEW', 'Industry')
    expect(r?.pills?.map((p) => p.label)).toEqual(['AI Infra', 'Dev Tools'])
    expect(r?.pills?.every((p) => p.tone === 'violet')).toBe(true)
  })

  it('renders Stage as a humanized neutral pill with a dot', () => {
    const r = row(g, 'OVERVIEW', 'Stage')
    expect(r?.pills?.[0]).toMatchObject({ label: 'Growth', tone: 'neutral', dot: true })
  })

  it('builds the HQ sentinel from city + state', () => {
    expect(row(g, 'OVERVIEW', 'HQ')?.value).toBe('San Francisco, CA')
  })

  it('formats financials (currency, humanized round, months)', () => {
    expect(row(g, 'FINANCIALS', 'Last round')?.value).toBe('Pre Seed')
    expect(row(g, 'FINANCIALS', 'Raise size')?.value).toBe('$2')
    expect(row(g, 'FINANCIALS', 'Initial valuation')?.value).toBe('$10')
    expect(row(g, 'FINANCIALS', 'ARR')?.value).toBe('$1.8M')
    expect(row(g, 'FINANCIALS', 'Runway')?.value).toBe('11 mo')
    // Co-investors (string[] from the synced join) render as a joined list,
    // NOT in the MORE fallback.
    expect(row(g, 'FINANCIALS', 'Co-investors')?.value).toBe('a16z, Index')
  })

  it('renders the Investment section — investmentMark plain, date UTC, security humanized', () => {
    expect(row(g, 'INVESTMENT', 'Portfolio')?.value).toBe('Fund Iv')
    expect(row(g, 'INVESTMENT', 'Initial investment')?.value).toBe('500000') // free-form text
    expect(row(g, 'INVESTMENT', 'Initial ownership')?.value).toBe('5%')
    expect(row(g, 'INVESTMENT', 'Investment mark')?.value).toBe('2.5') // NOT "$2.50"
    expect(row(g, 'INVESTMENT', 'Initial security')?.value).toBe('Safe')
    expect(row(g, 'INVESTMENT', 'Date of initial investment')?.value).toBe('Apr 14, 2026')
  })

  it('renders LINKS as labels (domain / linkedin path)', () => {
    expect(row(g, 'LINKS', 'Website')).toMatchObject({ value: 'amma.ai', link: true })
    expect(row(g, 'LINKS', 'LinkedIn')).toMatchObject({ value: '/company/amma', link: true })
  })

  it('MORE surfaces a new field but never structural/hidden ones', () => {
    expect(row(g, 'MORE', 'Secret sauce')?.value).toBe('umami')
    const moreKeys = g.find((x) => x.label === 'MORE')?.rows.map((r) => r.key) ?? []
    for (const hidden of ['Status', 'Entity type', 'Description', 'Key takeaways', 'Recent meetings', 'People']) {
      expect(moreKeys).not.toContain(hidden)
    }
  })

  it('drops empty groups for a sparse company', () => {
    expect(buildCompanyGroups({ id: 'x', name: 'Bare Co' })).toEqual([])
  })
})

const investor: LedgerDetail = {
  id: 'k1',
  fullName: 'Iris',
  title: 'Partner',
  primaryCompanyName: 'VC LLC',
  email: 'iris@vc.com',
  phone: '+1 555 0100',
  linkedinUrl: 'https://linkedin.com/in/iris',
  city: 'New York',
  state: 'NY',
  contactType: 'investor',
  relationshipStrength: 'strong',
  talentPipeline: 'exploring',
  tags: ['ai', 'infra'],
  fundSize: 50_000_000,
  typicalCheckSizeMin: 250_000,
  typicalCheckSizeMax: 1_000_000,
  investmentStageFocus: ['seed', 'series_a'],
  proudPortfolioCompanies: ['Acme'],
  notes: 'a note', // skip-listed
}

describe('buildContactGroups', () => {
  const g = buildContactGroups(investor)

  it('emits ABOUT / RELATIONSHIP / INVESTOR for an investor', () => {
    expect(sectionLabels(g)).toEqual(['ABOUT', 'RELATIONSHIP', 'INVESTOR'])
  })

  it('Type pill is green for investors; Relationship is a sky pill', () => {
    expect(row(g, 'RELATIONSHIP', 'Type')?.pills?.[0]).toMatchObject({ label: 'Investor', tone: 'green' })
    expect(row(g, 'RELATIONSHIP', 'Relationship')?.pills?.[0]).toMatchObject({ label: 'Strong', tone: 'sky' })
  })

  it('builds Location + Check-size sentinels and joins list fields', () => {
    expect(row(g, 'ABOUT', 'Location')?.value).toBe('New York, NY')
    expect(row(g, 'ABOUT', 'LinkedIn')?.value).toBe('/in/iris')
    expect(row(g, 'INVESTOR', 'Check size')?.value).toBe('$250K—$1.0M')
    expect(row(g, 'INVESTOR', 'Stage focus')?.value).toBe('seed, series_a')
    expect(row(g, 'RELATIONSHIP', 'Tags')?.value).toBe('ai, infra')
  })

  it('drops the INVESTOR group + uses a neutral Type pill for a non-investor', () => {
    const f = buildContactGroups({ id: 'f', fullName: 'Fred', title: 'CEO', contactType: 'founder' })
    expect(sectionLabels(f)).toEqual(['ABOUT', 'RELATIONSHIP'])
    expect(row(f, 'RELATIONSHIP', 'Type')?.pills?.[0]).toMatchObject({ label: 'Founder', tone: 'neutral' })
  })
})
