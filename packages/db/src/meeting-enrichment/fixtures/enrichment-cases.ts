// Golden fixtures for the meeting-enrichment planner. PERSISTENCE-AGNOSTIC by
// design: `existing` is plain JSON (arrays, not Maps) so the SAME table can drive
//   1. planMeetingEnrichment unit tests (here / enrichment-plan.test.ts), and
//   2. PR2/PR3's applyWritePlan tests against BOTH the desktop (SQLite) and
//      gateway (Drizzle) persisters — proving they can't drift.
// `toExistingState` expands a contact's emails[] into the email-keyed Map the
// planner reads (reproducing "match by primary OR secondary email").
//
// Expected plans are HARDCODED, not derived from the lifted helpers — so a change
// to a helper (e.g. humanizeDomainName) makes a golden case FAIL rather than
// silently moving both the expectation and the result together. The leaf helpers
// are separately pinned by the regression-lock tests.

import {
  createEmptyPlan,
  type AttendeeInput,
  type CompanyNameUpdate,
  type ContactToCreate,
  type ExistingCompany,
  type ExistingContact,
  type ExistingState,
  type MeetingCompanyLink,
  type MeetingContactLink,
  type PlanOptions,
  type WritePlan,
} from '../plan'
import { normalizeEmail, normalizeName, splitFullNameParts } from '../helpers'

// ─── fixture → ExistingState ────────────────────────────────────────────────

export interface ExistingContactFixture {
  id: string
  fullName: string
  /** defaults to normalizeName(fullName) */
  normalizedName?: string
  /** defaults to splitFullNameParts(fullName) */
  firstName?: string | null
  lastName?: string | null
  /** defaults to emails[0] ?? null; pass null explicitly to model a missing primary */
  primaryEmail?: string | null
  /** all emails (primary + secondary); each becomes a Map key */
  emails: string[]
}

export interface ExistingStateFixture {
  contacts?: ExistingContactFixture[]
  companies?: ExistingCompany[]
  currentMeetingCompanyLinkIds?: string[]
}

export function toExistingState(fix: ExistingStateFixture): ExistingState {
  const contactsByEmail = new Map<string, ExistingContact>()
  for (const c of fix.contacts || []) {
    const split = splitFullNameParts(c.fullName)
    const contact: ExistingContact = {
      id: c.id,
      fullName: c.fullName,
      normalizedName: c.normalizedName ?? normalizeName(c.fullName),
      firstName: c.firstName !== undefined ? c.firstName : split.firstName,
      lastName: c.lastName !== undefined ? c.lastName : split.lastName,
      primaryEmail: c.primaryEmail !== undefined ? c.primaryEmail : (c.emails[0] ?? null),
    }
    for (const e of c.emails) {
      const key = normalizeEmail(e)
      if (key) contactsByEmail.set(key, contact)
    }
  }
  return {
    contactsByEmail,
    companies: fix.companies || [],
    currentMeetingCompanyLinkIds: fix.currentMeetingCompanyLinkIds || [],
  }
}

// ─── compact builders for expected plans ────────────────────────────────────

const M = 'mtg-1'

function expectPlan(partial: Partial<WritePlan>): WritePlan {
  return { ...createEmptyPlan(), ...partial }
}
const coLink = (companyId: string | null, seedKey: string | null): MeetingCompanyLink => ({
  meetingId: M,
  companyId,
  seedKey,
  confidence: 0.7,
  linkedBy: 'auto',
})
const ctLink = (email: string, contactId: string | null): MeetingContactLink => ({
  meetingId: M,
  email,
  contactId,
})
const newContact = (
  email: string,
  fullName: string,
  normalizedName: string,
  firstName: string | null = null,
  lastName: string | null = null,
): ContactToCreate => ({ email, fullName, normalizedName, firstName, lastName })

const mkOpts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  meetingId: M,
  ownerEmail: null,
  isGroupEvent: false,
  ...over,
})

// A reusable existing "Acme" company with name + domain aliases.
const ACME: ExistingCompany = {
  id: 'co-acme',
  canonicalName: 'Acme',
  normalizedName: 'acme',
  primaryDomain: 'acme.com',
  nameAliases: ['Acme'],
  domainAliases: ['acme.com', 'www.acme.com'],
}

// ─── planMeetingEnrichment golden table ─────────────────────────────────────

export interface EnrichmentCase {
  name: string
  existing: ExistingStateFixture
  attendees: AttendeeInput
  opts: PlanOptions
  expectedPlan: WritePlan
}

export const ENRICHMENT_CASES: EnrichmentCase[] = [
  {
    name: 'company match by normalized name',
    existing: { companies: [ACME] },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-acme', null)] }),
  },
  {
    name: 'company match by name alias',
    existing: {
      companies: [
        {
          id: 'co-x',
          canonicalName: 'Acme Corporation',
          normalizedName: 'acme corporation',
          primaryDomain: null,
          nameAliases: ['Acme'],
          domainAliases: [],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-x', null)] }),
  },
  {
    name: 'company match by primary domain',
    existing: {
      companies: [
        {
          id: 'co-d',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'acme.com',
          nameAliases: ['Acme'],
          domainAliases: [],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme Inc'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-d', null)] }),
  },
  {
    name: 'company match by domain alias',
    existing: {
      companies: [
        {
          id: 'co-a',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'other.com',
          nameAliases: ['Acme'],
          domainAliases: ['acme.com', 'www.acme.com'],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme Inc'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-a', null)] }),
  },
  {
    name: 'company create when no match',
    existing: { companies: [] },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme'] }),
    expectedPlan: expectPlan({
      companiesToCreate: [
        {
          seedKey: 'acme',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'acme.com',
          nameAliases: ['Acme'],
          domainAliases: ['acme.com', 'www.acme.com'],
        },
      ],
      meetingCompanyLinks: [coLink(null, 'acme')],
    }),
  },
  {
    name: 'company precedence: name beats domain',
    existing: {
      companies: [
        {
          id: 'co-name',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'zzz.com',
          nameAliases: ['Acme'],
          domainAliases: [],
        },
        {
          id: 'co-domain',
          canonicalName: 'Other',
          normalizedName: 'other',
          primaryDomain: 'acme.com',
          nameAliases: ['Other'],
          domainAliases: [],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-name', null)] }),
  },
  {
    name: 'link prune: stale link dropped, resolved link kept',
    existing: { companies: [ACME], currentMeetingCompanyLinkIds: ['co-stale', 'co-acme'] },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme'] }),
    expectedPlan: expectPlan({
      meetingCompanyLinks: [coLink('co-acme', null)],
      companyLinksToPrune: [{ meetingId: M, companyId: 'co-stale' }],
    }),
  },
  {
    name: 'self exclusion: owner email dropped from contacts',
    existing: {},
    attendees: { attendees: null, attendeeEmails: ['owner@acme.com', 'jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'owner@acme.com', companies: [] }),
    expectedPlan: expectPlan({
      contactsToCreate: [newContact('jane@acme.com', 'Jane', 'jane')],
      meetingContactLinks: [ctLink('jane@acme.com', null)],
    }),
  },
  {
    name: 'notification email skip',
    existing: {},
    attendees: { attendees: null, attendeeEmails: ['noreply@acme.com', 'jane@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      contactsToCreate: [newContact('jane@acme.com', 'Jane', 'jane')],
      meetingContactLinks: [ctLink('jane@acme.com', null)],
    }),
  },
  {
    name: 'group-event skip → empty plan',
    existing: {},
    attendees: {
      attendees: null,
      attendeeEmails: Array.from({ length: 11 }, (_, i) => `p${i}@acme.com`),
    },
    opts: mkOpts({ isGroupEvent: true, companies: ['Acme'] }),
    expectedPlan: createEmptyPlan(),
  },
  {
    name: 'dedup vs existing contact (match by primary, no-op)',
    existing: {
      contacts: [
        {
          id: 'c1',
          fullName: 'Jane Doe',
          primaryEmail: 'jane@acme.com',
          emails: ['jane@acme.com'],
        },
      ],
    },
    attendees: { attendees: ['Jane Doe <jane@acme.com>'], attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({ meetingContactLinks: [ctLink('jane@acme.com', 'c1')] }),
  },
  {
    name: 'dedup match via secondary email',
    existing: {
      contacts: [
        {
          id: 'c2',
          fullName: 'Bob Lee',
          primaryEmail: 'bob@old.com',
          emails: ['bob@old.com', 'bob@acme.com'],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['bob@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({ meetingContactLinks: [ctLink('bob@acme.com', 'c2')] }),
  },
  {
    name: 'primary email backfill (existing contact had no primary)',
    existing: {
      contacts: [
        {
          id: 'c3',
          fullName: 'Cara Ng',
          primaryEmail: null,
          emails: ['cara@acme.com'],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['cara@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      emailsToAdd: [{ contactId: 'c3', email: 'cara@acme.com', isPrimary: true }],
      meetingContactLinks: [ctLink('cara@acme.com', 'c3')],
    }),
  },
  {
    name: 'name upgrade: low-quality existing + explicit candidate',
    existing: {
      contacts: [
        {
          id: 'c4',
          fullName: 'jdoe',
          normalizedName: 'jdoe',
          firstName: null,
          lastName: null,
          primaryEmail: 'jdoe@acme.com',
          emails: ['jdoe@acme.com'],
        },
      ],
    },
    attendees: { attendees: ['Jane Doe <jdoe@acme.com>'], attendeeEmails: ['jdoe@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      contactNameUpdates: [
        {
          contactId: 'c4',
          fullName: 'Jane Doe',
          normalizedName: 'jane doe',
          firstName: 'Jane',
          lastName: 'Doe',
        },
      ],
      meetingContactLinks: [ctLink('jdoe@acme.com', 'c4')],
    }),
  },
  {
    name: 'no name upgrade: good existing, weaker candidate',
    existing: {
      contacts: [
        {
          id: 'c5',
          fullName: 'Jane Alexandra Doe',
          primaryEmail: 'jane@acme.com',
          emails: ['jane@acme.com'],
        },
      ],
    },
    attendees: { attendees: ['Jane Doe <jane@acme.com>'], attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({ meetingContactLinks: [ctLink('jane@acme.com', 'c5')] }),
  },
  {
    name: 'name upgrade on empty existing name',
    existing: {
      contacts: [
        {
          id: 'c6',
          fullName: '',
          normalizedName: '',
          firstName: null,
          lastName: null,
          primaryEmail: 'sam@acme.com',
          emails: ['sam@acme.com'],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['sam@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      contactNameUpdates: [
        { contactId: 'c6', fullName: 'Sam', normalizedName: 'sam', firstName: null, lastName: null },
      ],
      meetingContactLinks: [ctLink('sam@acme.com', 'c6')],
    }),
  },
  {
    name: 'candidate dedup: explicit name wins over bare + inferred',
    existing: {},
    attendees: {
      attendees: ['jane@acme.com', 'Jane Doe <jane@acme.com>'],
      attendeeEmails: ['jane@acme.com'],
    },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      contactsToCreate: [newContact('jane@acme.com', 'Jane Doe', 'jane doe', 'Jane', 'Doe')],
      meetingContactLinks: [ctLink('jane@acme.com', null)],
    }),
  },
  {
    name: 'empty attendees → empty plan',
    existing: {},
    attendees: { attendees: null, attendeeEmails: null },
    opts: mkOpts({ companies: null }),
    expectedPlan: createEmptyPlan(),
  },
  {
    name: 'free-provider domain → no company, contact still created',
    existing: {},
    attendees: { attendees: null, attendeeEmails: ['jane@gmail.com'] },
    opts: mkOpts({ companies: null }),
    expectedPlan: expectPlan({
      contactsToCreate: [newContact('jane@gmail.com', 'Jane', 'jane')],
      meetingContactLinks: [ctLink('jane@gmail.com', null)],
    }),
  },
  {
    name: 'multiple companies in one meeting (first domain used for all created)',
    existing: {},
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com', 'bob@beta.io'] },
    opts: mkOpts({ companies: ['Acme', 'Beta'] }),
    expectedPlan: expectPlan({
      contactsToCreate: [
        newContact('jane@acme.com', 'Jane', 'jane'),
        newContact('bob@beta.io', 'Bob', 'bob'),
      ],
      meetingContactLinks: [ctLink('jane@acme.com', null), ctLink('bob@beta.io', null)],
      companiesToCreate: [
        {
          seedKey: 'acme',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'acme.com',
          nameAliases: ['Acme'],
          domainAliases: ['acme.com', 'www.acme.com'],
        },
        {
          seedKey: 'beta',
          canonicalName: 'Beta',
          normalizedName: 'beta',
          primaryDomain: 'acme.com',
          nameAliases: ['Beta'],
          domainAliases: ['acme.com', 'www.acme.com'],
        },
      ],
      meetingCompanyLinks: [coLink(null, 'acme'), coLink(null, 'beta')],
    }),
  },

  // ── test-diagram gap fills ──────────────────────────────────────────────
  {
    name: 'invalid email skipped (B4)',
    existing: {},
    attendees: { attendees: null, attendeeEmails: ['not-an-email', 'jane@acme.com'] },
    opts: mkOpts({ companies: [] }),
    expectedPlan: expectPlan({
      contactsToCreate: [newContact('jane@acme.com', 'Jane', 'jane')],
      meetingContactLinks: [ctLink('jane@acme.com', null)],
    }),
  },
  {
    name: 'derive seed company names when opts.companies omitted',
    existing: { companies: [] },
    attendees: { attendees: null, attendeeEmails: ['jane@redswanventures.com'] },
    // ownerEmail excludes the only contact so the case isolates seed derivation.
    opts: mkOpts({ ownerEmail: 'jane@redswanventures.com' }),
    expectedPlan: expectPlan({
      companiesToCreate: [
        {
          seedKey: 'red swan ventures',
          canonicalName: 'Red Swan Ventures',
          normalizedName: 'red swan ventures',
          primaryDomain: 'redswanventures.com',
          nameAliases: ['Red Swan Ventures'],
          domainAliases: ['redswanventures.com', 'www.redswanventures.com'],
        },
      ],
      meetingCompanyLinks: [coLink(null, 'red swan ventures')],
    }),
  },
  {
    name: 'www-stripped primary domain equivalence (B18)',
    existing: {
      companies: [
        {
          id: 'co-www',
          canonicalName: 'Acme',
          normalizedName: 'acme',
          primaryDomain: 'www.acme.com',
          nameAliases: ['Acme'],
          domainAliases: [],
        },
      ],
    },
    attendees: { attendees: null, attendeeEmails: ['jane@acme.com'] },
    opts: mkOpts({ ownerEmail: 'jane@acme.com', companies: ['Acme Inc'] }),
    expectedPlan: expectPlan({ meetingCompanyLinks: [coLink('co-www', null)] }),
  },
]

// ─── planCompanyNameUpdates golden table ────────────────────────────────────

export interface NameUpdateCase {
  name: string
  plan: WritePlan
  existing: ExistingState
  resolved: Array<{ domain: string; name: string }>
  expected: CompanyNameUpdate[]
}

const emptyExisting: ExistingState = {
  contactsByEmail: new Map(),
  companies: [],
  currentMeetingCompanyLinkIds: [],
}

const planCreatingAcme = expectPlan({
  companiesToCreate: [
    {
      seedKey: 'acme',
      canonicalName: 'Acme',
      normalizedName: 'acme',
      primaryDomain: 'acme.com',
      nameAliases: ['Acme'],
      domainAliases: ['acme.com', 'www.acme.com'],
    },
  ],
  meetingCompanyLinks: [coLink(null, 'acme')],
})

const planLinkingExistingAcme = expectPlan({ meetingCompanyLinks: [coLink('co-acme', null)] })

export const NAME_UPDATE_CASES: NameUpdateCase[] = [
  {
    name: 'resolved name differs from created seed → update by seedKey',
    plan: planCreatingAcme,
    existing: emptyExisting,
    resolved: [{ domain: 'acme.com', name: 'Acme Inc' }],
    expected: [{ companyId: null, seedKey: 'acme', canonicalName: 'Acme Inc', normalizedName: 'acme inc' }],
  },
  {
    name: 'resolved name equals seed (normalized) → no update',
    plan: planCreatingAcme,
    existing: emptyExisting,
    resolved: [{ domain: 'acme.com', name: 'Acme' }],
    expected: [],
  },
  {
    name: 'resolved name for matched existing company → update by companyId',
    plan: planLinkingExistingAcme,
    existing: { ...emptyExisting, companies: [{ ...ACME, nameIsAuto: true }] },
    resolved: [{ domain: 'acme.com', name: 'Acme Inc' }],
    expected: [{ companyId: 'co-acme', seedKey: null, canonicalName: 'Acme Inc', normalizedName: 'acme inc' }],
  },
  {
    name: 'no resolved name for the company domain → no update',
    plan: planCreatingAcme,
    existing: emptyExisting,
    resolved: [{ domain: 'beta.io', name: 'Beta' }],
    expected: [],
  },
  {
    name: 'user-edited existing name (nameIsAuto:false) is never overwritten',
    plan: planLinkingExistingAcme,
    existing: { ...emptyExisting, companies: [{ ...ACME, nameIsAuto: false }] },
    resolved: [{ domain: 'acme.com', name: 'Acme Inc' }],
    expected: [],
  },
]
