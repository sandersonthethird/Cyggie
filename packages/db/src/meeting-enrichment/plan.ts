// The pure, synchronous heart of meeting-creation enrichment: turn an attendee
// list + already-fetched existing CRM state into a WritePlan describing every
// owned-row write. No DB, no I/O, no electron — so the desktop (SQLite via the
// withSync barrel) and the gateway (Drizzle/Neon) drive the SAME decision logic
// and provably can't drift. Each caller fetches the `existing` state (batched)
// and persists the returned WritePlan in its own idiom.
//
// This re-expresses three DB-coupled desktop functions as one pure function over
// in-memory data:
//   contact.repo.ts  buildCandidateMap + applyCandidates  → contacts/links/name-updates
//   meeting.repo.ts  findExistingCompanyId + createCompanyForMeeting
//                    + syncMeetingCompanyLinks            → companies/links/prune
//
//   attendees ─▶ buildCandidates ─▶ dedup vs existing ─▶ WritePlan ─▶ (persist) ─▶ name-enrich
//      │nil/[]→{}  │self/notif skip   │exists→ no-op/update    │                    │resolveCompanyName
//      │group→{}   │explicit-name win │new→ create             │              planCompanyNameUpdates
//
// NAME RESOLUTION (resolveCompanyName) is async and runs AFTER the plan is
// persisted, so `planMeetingEnrichment` leaves `companyNameUpdates` empty; the
// caller resolves names then calls `planCompanyNameUpdates` for that tail.
//
// NOT modelled here (deliberately, deferred to the per-context persister):
//   - contact → primary-company linking (findCompanyIdByEmail): a DB read the
//     persister does at apply time.
//   - desktop soft-delete tombstone skip on create: a desktop-local filter the
//     persister applies to `contactsToCreate`.
//   - outbox/lamport stamping: lives in the withSync barrel (desktop) / Drizzle
//     write (gateway).

import {
  deriveSeedCompanyNames,
  extractEmailDomain,
  getDomainLookupCandidates,
  getRegistrableDomain,
  inferNameFromEmail,
  isLikelyLowQualityStoredName,
  isNotificationEmail,
  mergeCandidate,
  nameQualityScore,
  normalizeCompanyName,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  parseAttendeeEntry,
  splitFullNameParts,
  type CandidateContact,
} from './helpers'

// ─── INPUTS ──────────────────────────────────────────────────────────────────

/**
 * An already-fetched existing contact. The caller keys these in
 * `ExistingState.contactsByEmail` under EVERY one of its normalized emails
 * (primary + every secondary), so the planner reproduces the desktop's "match by
 * primary OR secondary email" lookup without SQL.
 */
export interface ExistingContact {
  id: string
  fullName: string // contacts.full_name
  normalizedName: string // contacts.normalized_name ('' for legacy rows)
  firstName: string | null // contacts.first_name (for the name-change guard)
  lastName: string | null // contacts.last_name
  primaryEmail: string | null // contacts.email (normalized), null/'' allowed
}

/** An already-fetched existing company, with everything the precedence match needs. */
export interface ExistingCompany {
  id: string
  canonicalName: string // org_companies.canonical_name
  normalizedName: string // org_companies.normalized_name
  primaryDomain: string | null
  nameAliases: string[] // org_company_aliases alias_type='name'
  domainAliases: string[] // org_company_aliases alias_type='domain'
  /**
   * True/undefined when the stored name was machine-derived (heuristic/enrichment),
   * false when a user edited it. `planCompanyNameUpdates` NEVER overwrites a name
   * with `nameIsAuto === false`, so a user-curated company name survives re-fires.
   */
  nameIsAuto?: boolean
}

/**
 * Everything the planner reads. The caller batches these (one read each).
 *
 * Caller contract (perf): `companies` MUST be pre-filtered to the meeting's
 * CANDIDATE companies — fetched by the seed normalized-names + attendee
 * registrable-domains — never the firm's whole company table. The planner walks
 * this array in-memory, so it stays O(seeds × candidates).
 */
export interface ExistingState {
  /** keyed by normalized email → owning contact (same contact under each of its emails). */
  contactsByEmail: Map<string, ExistingContact>
  /** candidate companies for this meeting's user/firm scope (see contract above). */
  companies: ExistingCompany[]
  /** company_ids currently linked to THIS meeting (drives the prune). */
  currentMeetingCompanyLinkIds: string[]
}

/** The raw attendee inputs (same shape the desktop stores on the meeting row). */
export interface AttendeeInput {
  attendees: string[] | null
  attendeeEmails: string[] | null
}

/** Caller-supplied options. */
export interface PlanOptions {
  meetingId: string
  /** Owner/self email — excluded from contacts (planner normalizes it). */
  ownerEmail: string | null
  /**
   * Group-event flag. true → EMPTY_PLAN. The caller computes this (it may be
   * user-overridden via isGroupEventUserSet); the planner TRUSTS it and never
   * recomputes from attendee count.
   */
  isGroupEvent: boolean
  /**
   * Seed company names to consider. When omitted/null the planner derives them
   * from attendee email domains (mirrors the desktop `companies` column).
   */
  companies?: string[] | null
}

// ─── OUTPUT (WritePlan) ──────────────────────────────────────────────────────

export interface ContactToCreate {
  email: string // normalized primary email
  fullName: string
  normalizedName: string
  firstName: string | null
  lastName: string | null
}
export interface EmailToAdd {
  contactId: string
  email: string // normalized
  isPrimary: boolean // true when the existing contact had no primary email (backfill)
}
export interface ContactNameUpdate {
  contactId: string
  fullName: string
  normalizedName: string
  firstName: string | null
  lastName: string | null
}
export interface MeetingContactLink {
  meetingId: string
  email: string // resolve → contactId at persist (new) / known id (existing)
  contactId: string | null // set for existing; null for a to-be-created contact
}
export interface CompanyToCreate {
  /** stable key the link / name-update arrays reference before a real id exists. */
  seedKey: string // = normalizedName (unique per plan)
  canonicalName: string // trimmed seed name
  normalizedName: string
  primaryDomain: string | null
  nameAliases: string[] // [trimmed canonicalName]
  domainAliases: string[] // getDomainLookupCandidates(primaryDomain)
}
export interface MeetingCompanyLink {
  meetingId: string
  companyId: string | null // existing match id, OR null when it references a CompanyToCreate
  seedKey: string | null // set when companyId is null (→ resolve post-create)
  confidence: number // 0.7 (matches desktop)
  linkedBy: string // 'auto'
}
export interface CompanyLinkToPrune {
  meetingId: string
  companyId: string
}
export interface CompanyNameUpdate {
  companyId: string | null // existing company id, OR null for a CompanyToCreate (use seedKey)
  seedKey: string | null
  canonicalName: string // resolved real name
  normalizedName: string // normalizeCompanyName(resolved)
}

export interface WritePlan {
  contactsToCreate: ContactToCreate[]
  emailsToAdd: EmailToAdd[]
  contactNameUpdates: ContactNameUpdate[]
  meetingContactLinks: MeetingContactLink[]
  companiesToCreate: CompanyToCreate[]
  meetingCompanyLinks: MeetingCompanyLink[]
  companyLinksToPrune: CompanyLinkToPrune[]
  /** [] from planMeetingEnrichment; filled by planCompanyNameUpdates after name resolution. */
  companyNameUpdates: CompanyNameUpdate[]
}

const MEETING_COMPANY_CONFIDENCE = 0.7
const MEETING_COMPANY_LINKED_BY = 'auto'

/** A fresh empty plan. Always returns a NEW object — never share a const. */
export function createEmptyPlan(): WritePlan {
  return {
    contactsToCreate: [],
    emailsToAdd: [],
    contactNameUpdates: [],
    meetingContactLinks: [],
    companiesToCreate: [],
    meetingCompanyLinks: [],
    companyLinksToPrune: [],
    companyNameUpdates: [],
  }
}

/** Immutable canonical empty plan — for reference/equality in tests. Do not mutate. */
export const EMPTY_PLAN: Readonly<WritePlan> = Object.freeze(createEmptyPlan())

// ─── CONTACT CANDIDATES (port of contact.repo.ts buildCandidateMap) ──────────

/**
 * Build deduped contact candidates from the attendee inputs. Two-pass to mirror
 * the desktop: (1) pair attendeeEmails[i] with parseAttendeeEntry(attendees[i]);
 * (2) parse each attendee entry directly. Self (owner) + notification/bot
 * addresses are skipped; duplicates by email collapse via mergeCandidate
 * (explicit name wins). Pure — exported for the characterization test.
 */
export function buildCandidates(
  attendees: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined,
  ownerEmail: string | null,
): CandidateContact[] {
  const map = new Map<string, CandidateContact>()
  const attendeeList = attendees || []
  const attendeeEmailList = attendeeEmails || []
  const normalizedOwnerEmail = ownerEmail ? normalizeEmail(ownerEmail) : null

  const addCandidate = (emailValue: string, nameValue: string | null, explicitName: boolean): void => {
    const email = normalizeEmail(emailValue)
    if (!email) return
    if (normalizedOwnerEmail && email === normalizedOwnerEmail) return // never the app owner
    if (isNotificationEmail(email)) return // never a bot/notification address

    const fullName = nameValue || inferNameFromEmail(email)
    const normalizedName = normalizeName(fullName)
    if (!normalizedName) return

    map.set(email, mergeCandidate(map.get(email), { email, fullName, normalizedName, explicitName }))
  }

  for (let i = 0; i < attendeeEmailList.length; i += 1) {
    const emailEntry = attendeeEmailList[i]
    if (!emailEntry) continue
    const parsed = parseAttendeeEntry(attendeeList[i] || '')
    addCandidate(emailEntry, parsed.fullName, parsed.explicitName)
  }

  for (const attendee of attendeeList) {
    const parsed = parseAttendeeEntry(attendee)
    if (parsed.email) addCandidate(parsed.email, parsed.fullName, parsed.explicitName)
  }

  return [...map.values()]
}

// ─── COMPANY MATCHING (port of meeting.repo.ts findExistingCompanyId) ────────

/** SQL parity: lower(trim(primary_domain)) = candidate OR www-stripped = candidate. */
function matchesPrimaryDomain(primaryDomain: string | null, candidate: string): boolean {
  if (!primaryDomain) return false
  const pd = primaryDomain.trim().toLowerCase()
  const stripped = pd.startsWith('www.') ? pd.slice(4) : pd
  return pd === candidate || stripped === candidate
}

/**
 * Find an existing company for a seed name over the in-memory candidate set, with
 * the desktop's precedence: normalized name → name alias → primary domain → domain
 * alias. Returns the matched company id, or null to create one.
 */
export function matchExistingCompany(
  companies: ExistingCompany[],
  companyName: string,
  attendeeEmails: string[] | null | undefined,
): string | null {
  const normalizedName = normalizeCompanyName(companyName)
  if (!normalizedName) return null

  // 1. exact normalized name
  for (const c of companies) {
    if (c.normalizedName === normalizedName) return c.id
  }

  // 2. name alias (case-insensitive, trimmed)
  const nameKey = companyName.trim().toLowerCase()
  for (const c of companies) {
    if (c.nameAliases.some((a) => a.trim().toLowerCase() === nameKey)) return c.id
  }

  // 3 + 4. by attendee email domain → primary domain, then domain alias
  const emailDomains = new Set<string>()
  for (const email of attendeeEmails || []) {
    const domain = extractEmailDomain(email)
    if (!domain) continue
    emailDomains.add(domain)
    emailDomains.add(getRegistrableDomain(domain))
  }
  if (emailDomains.size === 0) return null

  for (const domain of emailDomains) {
    for (const candidate of getDomainLookupCandidates(domain)) {
      // primary-domain match across ALL companies first (mirrors the two LIMIT-1 queries)…
      for (const c of companies) {
        if (matchesPrimaryDomain(c.primaryDomain, candidate)) return c.id
      }
      // …then domain-alias match across all.
      for (const c of companies) {
        if (c.domainAliases.some((a) => a.trim().toLowerCase() === candidate.trim().toLowerCase())) {
          return c.id
        }
      }
    }
  }

  return null
}

/** Registrable domain of the first attendee email (port of createCompanyForMeeting). */
function derivePrimaryDomain(attendeeEmails: string[] | null | undefined): string | null {
  const domains = (attendeeEmails || [])
    .map((email) => extractEmailDomain(email))
    .filter((d): d is string => Boolean(d))
  return domains.length > 0 ? getRegistrableDomain(domains[0]) : null
}

// ─── THE PLANNER ─────────────────────────────────────────────────────────────

// ── T3 Slice 0: split into two independent halves the desktop calls from its own
//    input-driven triggers, composed back for the gateway's single call ─────────
//
//   planContacts ─┐  (steps 1–2: contacts; depends only on attendees+contacts)
//                 ├─▶ planMeetingEnrichment = {…contacts, …companyLinks}  (gateway)
//   planCompanyLinks ┘  (steps 3–4+prune: companies; depends only on companies+domains)
//
// No data flows between the halves — the contact→company link is a DB read the
// PERSISTER does at apply time, not modelled here. So `planMeetingEnrichment`
// deep-equals the spread of the two halves (asserted by the compose test).

/** Contact-write subset of a WritePlan (planContacts / planContactDecisions output). */
export type ContactPlan = Pick<
  WritePlan,
  'contactsToCreate' | 'emailsToAdd' | 'contactNameUpdates' | 'meetingContactLinks'
>
/** Company-write subset of a WritePlan (planCompanyLinks output). */
export type CompanyPlan = Pick<
  WritePlan,
  'companiesToCreate' | 'meetingCompanyLinks' | 'companyLinksToPrune'
>

/**
 * Contact decisions over an ALREADY-BUILT candidate list (steps 1–2). The desktop
 * bulk path (syncContactsFromMeetings) calls this directly with candidates merged
 * across many meetings; the per-meeting path goes through planContacts.
 */
export function planContactDecisions(
  existing: ExistingState,
  candidates: CandidateContact[],
  opts: PlanOptions,
): ContactPlan {
  const out: ContactPlan = {
    contactsToCreate: [],
    emailsToAdd: [],
    contactNameUpdates: [],
    meetingContactLinks: [],
  }
  if (opts.isGroupEvent) return out
  const { meetingId } = opts

  for (const candidate of candidates) {
    const match = existing.contactsByEmail.get(candidate.email)

    if (!match) {
      const split = splitFullNameParts(candidate.fullName)
      out.contactsToCreate.push({
        email: candidate.email,
        fullName: candidate.fullName,
        normalizedName: candidate.normalizedName,
        firstName: split.firstName,
        lastName: split.lastName,
      })
      out.meetingContactLinks.push({ meetingId, email: candidate.email, contactId: null })
      continue
    }

    // Name-quality upgrade decision — replicated EXACTLY from contact.repo.ts:578-605.
    let nextName = match.fullName
    let nextNormalized = match.normalizedName
    const existingNormalizedName = normalizeName(match.fullName)
    const namesDiffer = candidate.normalizedName !== existingNormalizedName
    const existingNameLowQuality = isLikelyLowQualityStoredName(match.fullName, match.primaryEmail)
    const shouldUpgradeName =
      nameQualityScore(candidate.fullName) >= nameQualityScore(match.fullName) + 12

    if (
      !match.fullName.trim() ||
      !match.normalizedName ||
      (candidate.explicitName && namesDiffer && (existingNameLowQuality || shouldUpgradeName))
    ) {
      nextName = candidate.fullName
      nextNormalized = candidate.normalizedName
    }

    const split = splitFullNameParts(nextName)
    if (
      nextName !== match.fullName ||
      nextNormalized !== match.normalizedName ||
      split.firstName !== match.firstName ||
      split.lastName !== match.lastName
    ) {
      out.contactNameUpdates.push({
        contactId: match.id,
        fullName: nextName,
        normalizedName: nextNormalized,
        firstName: split.firstName,
        lastName: split.lastName,
      })
    }

    // Primary-email backfill: the contact matched by this email but stored no primary.
    if (!match.primaryEmail || !match.primaryEmail.trim()) {
      out.emailsToAdd.push({ contactId: match.id, email: candidate.email, isPrimary: true })
    }

    out.meetingContactLinks.push({ meetingId, email: candidate.email, contactId: match.id })
  }

  return out
}

/** Contact half (steps 1–2): build candidates from raw attendee inputs, then decide. */
export function planContacts(
  existing: ExistingState,
  attendees: AttendeeInput,
  opts: PlanOptions,
): ContactPlan {
  if (opts.isGroupEvent) {
    return { contactsToCreate: [], emailsToAdd: [], contactNameUpdates: [], meetingContactLinks: [] }
  }
  const candidates = buildCandidates(attendees.attendees, attendees.attendeeEmails, opts.ownerEmail)
  return planContactDecisions(existing, candidates, opts)
}

/** Company half (steps 3–4 + prune): match/derive/link companies and prune stale links. */
export function planCompanyLinks(
  existing: ExistingState,
  attendees: AttendeeInput,
  opts: PlanOptions,
): CompanyPlan {
  const out: CompanyPlan = {
    companiesToCreate: [],
    meetingCompanyLinks: [],
    companyLinksToPrune: [],
  }
  if (opts.isGroupEvent) return out

  const attendeeList = attendees.attendees
  const attendeeEmails = attendees.attendeeEmails
  const seedNamesRaw = opts.companies ?? deriveSeedCompanyNames(attendeeList, attendeeEmails)
  const hasAttendees =
    (attendeeList?.length ?? 0) > 0 || (attendeeEmails?.length ?? 0) > 0
  // Match the original combined guard: nothing to do AND nothing to prune from.
  if (!hasAttendees && seedNamesRaw.length === 0) return out

  const { meetingId } = opts

  // Step 3 — seed company names (trim/dedup/drop-empty; mirrors syncMeetingCompanyLinks:260).
  const seedNames = [...new Set(seedNamesRaw.map((name) => name.trim()).filter(Boolean))]

  // Step 4 — company match / derive / link / prune. Domain logic uses attendeeEmails only.
  const resolvedCompanyIds = new Set<string>()
  const createdSeedKeys = new Set<string>()
  for (const seedName of seedNames) {
    const matchId = matchExistingCompany(existing.companies, seedName, attendeeEmails)
    if (matchId) {
      resolvedCompanyIds.add(matchId)
      out.meetingCompanyLinks.push({
        meetingId,
        companyId: matchId,
        seedKey: null,
        confidence: MEETING_COMPANY_CONFIDENCE,
        linkedBy: MEETING_COMPANY_LINKED_BY,
      })
      continue
    }

    const trimmed = seedName.trim()
    const normalized = normalizeCompanyName(trimmed)
    if (!normalized) continue // createCompanyForMeeting:180 — no normalized name → skip

    const seedKey = normalized
    if (!createdSeedKeys.has(seedKey)) {
      createdSeedKeys.add(seedKey)
      const primaryDomain = derivePrimaryDomain(attendeeEmails)
      out.companiesToCreate.push({
        seedKey,
        canonicalName: trimmed,
        normalizedName: normalized,
        primaryDomain,
        nameAliases: [trimmed],
        domainAliases: primaryDomain ? getDomainLookupCandidates(primaryDomain) : [],
      })
    }
    out.meetingCompanyLinks.push({
      meetingId,
      companyId: null,
      seedKey,
      confidence: MEETING_COMPANY_CONFIDENCE,
      linkedBy: MEETING_COMPANY_LINKED_BY,
    })
  }

  // Prune existing links whose company is no longer resolved (newly-created companies
  // can't be in currentMeetingCompanyLinkIds, so they're never pruned).
  for (const companyId of existing.currentMeetingCompanyLinkIds) {
    if (!resolvedCompanyIds.has(companyId)) {
      out.companyLinksToPrune.push({ meetingId, companyId })
    }
  }

  return out
}

/**
 * Plan every CRM write a meeting's attendee list implies, given already-fetched
 * existing state. Pure and synchronous — the GATEWAY's single call. Composes the
 * two independent halves. `companyNameUpdates` is always [] here — it's filled
 * post-persist by planCompanyNameUpdates once names resolve.
 */
export function planMeetingEnrichment(
  existing: ExistingState,
  attendees: AttendeeInput,
  opts: PlanOptions,
): WritePlan {
  return {
    ...planContacts(existing, attendees, opts),
    ...planCompanyLinks(existing, attendees, opts),
    companyNameUpdates: [],
  }
}

// ─── POST-RESOLUTION NAME UPDATES ────────────────────────────────────────────

/** Find a resolved name for a company by its primary domain + domain aliases. */
function lookupResolvedName(
  byDomain: Map<string, string>,
  primaryDomain: string | null,
  domainAliases: string[],
): string | null {
  const keys = [primaryDomain, ...domainAliases]
    .map((d) => normalizeDomain(d))
    .filter((d): d is string => Boolean(d))
  for (const key of keys) {
    const name = byDomain.get(key)
    if (name) return name
  }
  return null
}

/**
 * Decide which company rows should adopt a freshly-RESOLVED display name (output
 * of the async `resolveCompanyName`, which already plausibility-gated the names).
 * Pure + synchronous, runs AFTER the WritePlan is persisted. Emits an update when
 * the resolved name differs (by normalizeCompanyName) from the current/seed name,
 * and — for an existing company — only when `nameIsAuto !== false` so a
 * user-edited name is never clobbered.
 */
export function planCompanyNameUpdates(
  plan: WritePlan,
  existing: ExistingState,
  resolved: Array<{ domain: string; name: string }>,
): CompanyNameUpdate[] {
  const updates: CompanyNameUpdate[] = []
  const byDomain = new Map<string, string>()
  for (const r of resolved) {
    const key = normalizeDomain(r.domain)
    if (key && r.name) byDomain.set(key, r.name)
  }
  if (byDomain.size === 0) return updates

  // Companies created by this plan (referenced by seedKey).
  for (const company of plan.companiesToCreate) {
    const resolvedName = lookupResolvedName(byDomain, company.primaryDomain, company.domainAliases)
    if (!resolvedName) continue
    if (normalizeCompanyName(resolvedName) === company.normalizedName) continue
    updates.push({
      companyId: null,
      seedKey: company.seedKey,
      canonicalName: resolvedName,
      normalizedName: normalizeCompanyName(resolvedName),
    })
  }

  // Existing companies matched/linked by this plan (referenced by companyId).
  const seen = new Set<string>()
  for (const link of plan.meetingCompanyLinks) {
    if (!link.companyId || seen.has(link.companyId)) continue
    seen.add(link.companyId)
    const company = existing.companies.find((c) => c.id === link.companyId)
    if (!company) continue
    if (company.nameIsAuto === false) continue // never overwrite a user-edited name
    const resolvedName = lookupResolvedName(byDomain, company.primaryDomain, company.domainAliases)
    if (!resolvedName) continue
    if (normalizeCompanyName(resolvedName) === company.normalizedName) continue
    updates.push({
      companyId: company.id,
      seedKey: null,
      canonicalName: resolvedName,
      normalizedName: normalizeCompanyName(resolvedName),
    })
  }

  return updates
}
