import { describe, it, expect } from 'vitest'
import {
  createEmptyPlan,
  EMPTY_PLAN,
  planCompanyNameUpdates,
  buildCandidates,
  planCompanyLinks,
  planContactDecisions,
  planContacts,
  planMeetingEnrichment,
  type AttendeeInput,
  type PlanOptions,
} from './plan'
import {
  getDomainLookupCandidates,
  getRegistrableDomain,
  isLikelyLowQualityStoredName,
  nameQualityScore,
  normalizeCompanyName,
  normalizeName,
  normalizePersonNameCandidate,
} from './helpers'
import {
  ENRICHMENT_CASES,
  NAME_UPDATE_CASES,
  toExistingState,
} from './fixtures/enrichment-cases'

describe('planMeetingEnrichment (golden cases)', () => {
  // Expected plans are authored in the planner's insertion order, so a direct
  // deep-equal also verifies array ordering (candidate dedup, seed order).
  it.each(ENRICHMENT_CASES)('$name', (c) => {
    const plan = planMeetingEnrichment(toExistingState(c.existing), c.attendees, c.opts)
    expect(plan).toEqual(c.expectedPlan)
  })
})

// G1 (T3 Slice 0): the gateway's single call must deep-equal the spread of the two
// desktop halves, and each half must populate ONLY its own arrays (independence).
describe('planMeetingEnrichment ≡ compose(planContacts, planCompanyLinks)', () => {
  it.each(ENRICHMENT_CASES)('compose holds for $name', (c) => {
    const existing = toExistingState(c.existing)
    const contacts = planContacts(existing, c.attendees, c.opts)
    const companies = planCompanyLinks(existing, c.attendees, c.opts)
    expect(planMeetingEnrichment(existing, c.attendees, c.opts)).toEqual({
      ...contacts,
      ...companies,
      companyNameUpdates: [],
    })
    // independence: the contact half emits no company arrays and vice-versa
    expect(Object.keys(contacts).sort()).toEqual([
      'contactNameUpdates',
      'contactsToCreate',
      'emailsToAdd',
      'meetingContactLinks',
    ])
    expect(Object.keys(companies).sort()).toEqual([
      'companiesToCreate',
      'companyLinksToPrune',
      'meetingCompanyLinks',
    ])
  })

  it('planContacts(x) === planContactDecisions(buildCandidates(x)) — the bulk-path seam', () => {
    const c = ENRICHMENT_CASES.find((x) => x.expectedPlan.contactsToCreate.length > 0)!
    const existing = toExistingState(c.existing)
    const candidates = buildCandidates(c.attendees.attendees, c.attendees.attendeeEmails, c.opts.ownerEmail)
    expect(planContacts(existing, c.attendees, c.opts)).toEqual(
      planContactDecisions(existing, candidates, c.opts),
    )
  })
})

describe('planCompanyNameUpdates (golden cases)', () => {
  it.each(NAME_UPDATE_CASES)('$name', (c) => {
    expect(planCompanyNameUpdates(c.plan, c.existing, c.resolved)).toEqual(c.expected)
  })
})

describe('lifted-helper regression locks', () => {
  // Literal values copied from running the originals in packages/db + src/main.
  // If a lifted copy drifts from the desktop original, one of these FAILS — the
  // tripwire for the bounded duplication window until PR2 converges them.
  it('nameQualityScore matches the desktop scoring', () => {
    expect(nameQualityScore('Jane Doe')).toBe(86)
    expect(nameQualityScore('Jane Alexandra Doe')).toBe(101)
    expect(nameQualityScore('jdoe')).toBe(15)
    expect(nameQualityScore('')).toBe(0)
  })

  it('isLikelyLowQualityStoredName matches the desktop heuristic', () => {
    expect(isLikelyLowQualityStoredName('jdoe', 'jdoe@acme.com')).toBe(true)
    expect(isLikelyLowQualityStoredName('Jane', 'jane@acme.com')).toBe(true)
    expect(isLikelyLowQualityStoredName('Jane Doe', 'jane@acme.com')).toBe(false)
    // equals the email-inferred name → low quality
    expect(isLikelyLowQualityStoredName('Jane Acme', 'jane.acme@x.com')).toBe(true)
  })

  it('normalizePersonNameCandidate matches the desktop canonicalization', () => {
    expect(normalizePersonNameCandidate('Doe, Jane')).toBe('Jane Doe')
    expect(normalizePersonNameCandidate('Dr. Jane Doe')).toBe('Jane Doe')
    expect(normalizePersonNameCandidate('support')).toBeNull()
    expect(normalizePersonNameCandidate('jane@acme.com')).toBeNull()
  })

  it('normalizeName / normalizeCompanyName collapse non-alphanumerics', () => {
    expect(normalizeName('Jane Doe')).toBe('jane doe')
    expect(normalizeCompanyName('Red—Swan  Ventures')).toBe('red swan ventures')
    // Faithful quirk: terminal punctuation becomes a trailing space (no final trim).
    expect(normalizeName('Jane  Doe!')).toBe('jane doe ')
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme inc ')
  })

  it('getRegistrableDomain collapses to the registrable root', () => {
    expect(getRegistrableDomain('acme.com')).toBe('acme.com')
    expect(getRegistrableDomain('mail.eng.acme.com')).toBe('acme.com')
    expect(getRegistrableDomain('acme.co.uk')).toBe('acme.co.uk')
    expect(getRegistrableDomain('mail.acme.co.uk')).toBe('acme.co.uk')
  })

  it('getDomainLookupCandidates dedupes normalized + registrable + www', () => {
    expect(getDomainLookupCandidates('www.acme.com')).toEqual(['acme.com', 'www.acme.com'])
    expect(getDomainLookupCandidates('mail.acme.com')).toEqual([
      'mail.acme.com',
      'acme.com',
      'www.acme.com',
    ])
  })
})

describe('purity + immutability', () => {
  const attendees: AttendeeInput = { attendees: null, attendeeEmails: ['jane@acme.com'] }
  const opts: PlanOptions = { meetingId: 'm', ownerEmail: null, isGroupEvent: false, companies: ['Acme'] }

  it('group-event guard returns a fresh empty plan, not the shared EMPTY_PLAN const', () => {
    const plan = planMeetingEnrichment(toExistingState({}), attendees, { ...opts, isGroupEvent: true })
    expect(plan).toEqual(createEmptyPlan())
    expect(plan).not.toBe(EMPTY_PLAN)
    // mutating the result must not throw (it's not frozen) nor affect EMPTY_PLAN
    plan.contactsToCreate.push({
      email: 'x@y.com',
      fullName: 'X',
      normalizedName: 'x',
      firstName: null,
      lastName: null,
    })
    expect(EMPTY_PLAN.contactsToCreate).toHaveLength(0)
  })

  it('does not mutate its inputs', () => {
    const existing = toExistingState({
      companies: [
        {
          id: 'co-acme',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'acme.com',
          nameAliases: ['Acme'],
          domainAliases: ['acme.com', 'www.acme.com'],
        },
      ],
    })
    const attendeesSnapshot = JSON.stringify(attendees)
    const optsSnapshot = JSON.stringify(opts)
    const companiesSnapshot = JSON.stringify(existing.companies)

    planMeetingEnrichment(existing, attendees, opts)

    expect(JSON.stringify(attendees)).toBe(attendeesSnapshot)
    expect(JSON.stringify(opts)).toBe(optsSnapshot)
    expect(JSON.stringify(existing.companies)).toBe(companiesSnapshot)
  })

  it('EMPTY_PLAN is frozen', () => {
    expect(Object.isFrozen(EMPTY_PLAN)).toBe(true)
  })
})
