// PgEnrichmentStore — the GATEWAY's persister for the shared meeting-enrichment
// planner (T3 Slice 1). The Neon mirror of the desktop SqliteEnrichmentStore
// (packages/db/src/sqlite/repositories/enrichment-store.ts): same decisions (the
// pure planner in @cyggie/db/meeting-enrichment/plan), same resulting CRM rows, so
// a gateway-enriched meeting pulls down to desktop/mobile identical to one desktop
// would have produced.
//
// Differences from the desktop store:
//   • drizzle/Neon, not better-sqlite3.
//   • No outbox — a row's `lamport` (stamped here) is what /sync/pull ships, so we
//     just stamp lamport + firm_id + created_by_user_id on every owned row.
//   • One drizzle transaction wraps the whole apply → atomic (partial failure rolls
//     back; the meeting's enriched_at stays NULL so the sweep retries / desktop backstops).
//   • All reads are firm-scoped (WHERE firm_id = ?), so we never read another firm's CRM.
//
//   loadExistingState ─▶ planMeetingEnrichment (caller) ─▶ applyWritePlan (ONE txn)
//     contacts:  tombstone-skip → insert + contact_emails + contact→company link
//     names:     update
//     emails:    backfill primary + attach
//     companies: onConflict(firm_id, normalized_name) → seedKey→id + aliases
//     links:     upsert; prune

import { createId } from '@paralleldrive/cuid2'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import {
  extractEmailDomain,
  getDomainLookupCandidates,
  normalizeCompanyName,
  normalizeEmail,
} from '@cyggie/db/meeting-enrichment/helpers'
import type {
  ExistingCompany,
  ExistingContact,
  ExistingState,
  WritePlan,
} from '@cyggie/db/meeting-enrichment/plan'
import type { getDb } from '../../db'

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Everything applyWritePlan needs that the pure WritePlan can't carry. */
export interface PgLoadedState {
  state: ExistingState
  /** tombstoned emails among the candidates (email-keyed; gate create-new only). */
  tombstoned: Set<string>
  /** contact id → its primary_company_id (drives the existing-contact company-link backfill). */
  primaryCompanyByContactId: Map<string, string | null>
}

// ─── LOAD ──────────────────────────────────────────────────────────────────

/**
 * Firm-scoped batch read of the existing CRM state the planner needs:
 * contacts (by primary OR secondary email), candidate companies (by seed name /
 * name-alias / attendee domain), the meeting's current company links, the tombstone
 * set, and each matched contact's primary_company_id.
 */
export async function loadExistingState(
  db: Db,
  opts: {
    firmId: string
    candidateEmails: string[]
    seedNames: string[]
    attendeeEmails: string[]
    meetingId: string
  },
): Promise<PgLoadedState> {
  const { firmId, meetingId } = opts
  const contactsByEmail = new Map<string, ExistingContact>()
  const primaryCompanyByContactId = new Map<string, string | null>()
  const tombstoned = new Set<string>()

  const emails = [...new Set(opts.candidateEmails.map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e)))]

  if (emails.length > 0) {
    const ingest = (matchEmail: string, c: typeof contactRows[number]): void => {
      if (contactsByEmail.has(matchEmail)) return // primary pass wins over secondary
      contactsByEmail.set(matchEmail, {
        id: c.id,
        fullName: c.fullName,
        normalizedName: c.normalizedName,
        firstName: c.firstName,
        lastName: c.lastName,
        primaryEmail: c.email,
      })
      primaryCompanyByContactId.set(c.id, c.primaryCompanyId ?? null)
    }

    // Primary-email matches (firm-scoped, not soft-deleted).
    const contactRows = await db
      .select({
        id: schema.contacts.id,
        fullName: schema.contacts.fullName,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        normalizedName: schema.contacts.normalizedName,
        email: schema.contacts.email,
        primaryCompanyId: schema.contacts.primaryCompanyId,
      })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.firmId, firmId),
          isNull(schema.contacts.deletedAt),
          inArray(sql`lower(${schema.contacts.email})`, emails),
        ),
      )
    for (const c of contactRows) ingest(normalizeEmail(c.email ?? '') ?? '', c)

    // Secondary-email matches via contact_emails.
    const secRows = await db
      .select({
        id: schema.contacts.id,
        fullName: schema.contacts.fullName,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        normalizedName: schema.contacts.normalizedName,
        email: schema.contacts.email,
        primaryCompanyId: schema.contacts.primaryCompanyId,
        matchEmail: sql<string>`lower(${schema.contactEmails.email})`,
      })
      .from(schema.contactEmails)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.contactEmails.contactId))
      .where(
        and(
          eq(schema.contacts.firmId, firmId),
          isNull(schema.contacts.deletedAt),
          inArray(sql`lower(${schema.contactEmails.email})`, emails),
        ),
      )
    for (const c of secRows) ingest(c.matchEmail, c)

    // Tombstones (email-keyed; not firm-scoped in schema — single-firm beta).
    const tombRows = await db
      .select({ email: schema.contactTombstones.email })
      .from(schema.contactTombstones)
      .where(inArray(schema.contactTombstones.email, emails))
    for (const t of tombRows) tombstoned.add(t.email)
  }

  const companies = await loadCandidateCompanies(db, firmId, opts.seedNames, opts.attendeeEmails)

  const linkRows = await db
    .select({ companyId: schema.meetingCompanyLinks.companyId })
    .from(schema.meetingCompanyLinks)
    .where(eq(schema.meetingCompanyLinks.meetingId, meetingId))

  const state: ExistingState = {
    contactsByEmail,
    companies,
    currentMeetingCompanyLinkIds: linkRows.map((r) => r.companyId),
  }
  return { state, tombstoned, primaryCompanyByContactId }
}

/** Candidate companies for the meeting — by seed normalized-name, name alias, or attendee domain. */
async function loadCandidateCompanies(
  db: Db,
  firmId: string,
  seedNames: string[],
  attendeeEmails: string[],
): Promise<ExistingCompany[]> {
  const ids = new Set<string>()

  const normSeeds = [...new Set(seedNames.map((n) => normalizeCompanyName(n)).filter(Boolean))]
  if (normSeeds.length > 0) {
    const rows = await db
      .select({ id: schema.orgCompanies.id })
      .from(schema.orgCompanies)
      .where(and(eq(schema.orgCompanies.firmId, firmId), inArray(schema.orgCompanies.normalizedName, normSeeds)))
    for (const r of rows) ids.add(r.id)
  }

  const nameKeys = [...new Set(seedNames.map((n) => n.trim().toLowerCase()).filter(Boolean))]
  const domainCandidates = new Set<string>()
  for (const email of attendeeEmails) {
    const domain = extractEmailDomain(email)
    if (domain) for (const c of getDomainLookupCandidates(domain)) domainCandidates.add(c)
  }

  if (nameKeys.length > 0 || domainCandidates.size > 0) {
    const aliasConds = []
    if (nameKeys.length > 0) {
      aliasConds.push(
        and(eq(schema.orgCompanyAliases.aliasType, 'name'), inArray(sql`lower(trim(${schema.orgCompanyAliases.aliasValue}))`, nameKeys)),
      )
    }
    if (domainCandidates.size > 0) {
      aliasConds.push(
        and(eq(schema.orgCompanyAliases.aliasType, 'domain'), inArray(sql`lower(trim(${schema.orgCompanyAliases.aliasValue}))`, [...domainCandidates])),
      )
    }
    const aliasRows = await db
      .select({ companyId: schema.orgCompanyAliases.companyId })
      .from(schema.orgCompanyAliases)
      .innerJoin(schema.orgCompanies, eq(schema.orgCompanies.id, schema.orgCompanyAliases.companyId))
      .where(and(eq(schema.orgCompanies.firmId, firmId), or(...aliasConds)))
    for (const r of aliasRows) ids.add(r.companyId)
  }

  if (domainCandidates.size > 0) {
    const byDomain = await db
      .select({ id: schema.orgCompanies.id })
      .from(schema.orgCompanies)
      .where(
        and(
          eq(schema.orgCompanies.firmId, firmId),
          inArray(sql`lower(trim(${schema.orgCompanies.primaryDomain}))`, [...domainCandidates]),
        ),
      )
    for (const r of byDomain) ids.add(r.id)
  }

  if (ids.size === 0) return []

  const rows = await db
    .select({
      id: schema.orgCompanies.id,
      canonicalName: schema.orgCompanies.canonicalName,
      normalizedName: schema.orgCompanies.normalizedName,
      primaryDomain: schema.orgCompanies.primaryDomain,
    })
    .from(schema.orgCompanies)
    .where(inArray(schema.orgCompanies.id, [...ids]))

  const aliases = await db
    .select({
      companyId: schema.orgCompanyAliases.companyId,
      aliasValue: schema.orgCompanyAliases.aliasValue,
      aliasType: schema.orgCompanyAliases.aliasType,
    })
    .from(schema.orgCompanyAliases)
    .where(inArray(schema.orgCompanyAliases.companyId, [...ids]))

  return rows.map((row) => ({
    id: row.id,
    canonicalName: row.canonicalName,
    normalizedName: row.normalizedName,
    primaryDomain: row.primaryDomain,
    nameAliases: aliases.filter((a) => a.companyId === row.id && a.aliasType === 'name').map((a) => a.aliasValue),
    domainAliases: aliases.filter((a) => a.companyId === row.id && a.aliasType === 'domain').map((a) => a.aliasValue),
  }))
}

// ─── APPLY ─────────────────────────────────────────────────────────────────

export interface PgApplyStats {
  contactsCreated: number
  companiesCreated: number
  linksCreated: number
}

/**
 * Apply a WritePlan to Neon in ONE transaction — atomic + idempotent + firm-scoped.
 * Every owned row is lamport-stamped (so it pulls) + firm_id / created_by_user_id
 * stamped. A re-run finds existing contacts (by email) and companies (by firm +
 * normalized_name) → creates nothing new.
 */
export async function applyWritePlan(
  db: Db,
  opts: { userId: string; firmId: string; plan: WritePlan; loaded: PgLoadedState; attendeeEmails: string[] },
): Promise<PgApplyStats> {
  const { userId, firmId, plan, loaded } = opts
  const stats: PgApplyStats = { contactsCreated: 0, companiesCreated: 0, linksCreated: 0 }
  const lamport = String(Date.now())
  const now = new Date()

  await db.transaction(async (tx) => {
    // 1. New contacts — tombstone-skip, insert, attach email, infer primary company.
    for (const c of plan.contactsToCreate) {
      if (loaded.tombstoned.has(c.email)) continue
      const contactId = createId()
      const companyId = await findCompanyIdByDomain(tx, domainOfEmail(c.email), firmId)
      await tx.insert(schema.contacts).values({
        id: contactId,
        userId,
        firmId,
        fullName: c.fullName,
        firstName: c.firstName,
        lastName: c.lastName,
        normalizedName: c.normalizedName,
        email: c.email,
        primaryCompanyId: companyId,
        lamport,
        createdAt: now,
        updatedAt: now,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      await tx.insert(schema.contactEmails).values({ contactId, email: c.email, isPrimary: 1, lamport, createdAt: now })
      if (companyId) await linkContactCompany(tx, companyId, contactId)
      stats.contactsCreated += 1
    }

    // 2. Name upgrades on existing contacts.
    for (const u of plan.contactNameUpdates) {
      await tx
        .update(schema.contacts)
        .set({
          fullName: u.fullName,
          firstName: u.firstName,
          lastName: u.lastName,
          normalizedName: u.normalizedName,
          updatedByUserId: userId,
          updatedAt: now,
          lamport,
        })
        .where(eq(schema.contacts.id, u.contactId))
    }

    // 3. Email backfill on existing contacts (attach + set blank primary).
    for (const e of plan.emailsToAdd) {
      await tx
        .insert(schema.contactEmails)
        .values({ contactId: e.contactId, email: e.email, isPrimary: e.isPrimary ? 1 : 0, lamport, createdAt: now })
        .onConflictDoNothing()
      if (e.isPrimary) {
        await tx
          .update(schema.contacts)
          .set({ email: e.email, updatedByUserId: userId, updatedAt: now, lamport })
          .where(and(eq(schema.contacts.id, e.contactId), or(isNull(schema.contacts.email), eq(sql`trim(${schema.contacts.email})`, ''))))
      }
    }

    // 4. Contact→company link for existing matched contacts that lack a primary company.
    for (const link of plan.meetingContactLinks) {
      if (!link.contactId) continue // a to-be-created contact — handled in step 1
      if (loaded.primaryCompanyByContactId.get(link.contactId)) continue // already linked
      const companyId = await findCompanyIdByDomain(tx, domainOfEmail(link.email), firmId)
      if (!companyId) continue
      await tx
        .update(schema.contacts)
        .set({ primaryCompanyId: companyId, updatedByUserId: userId, updatedAt: now, lamport })
        .where(and(eq(schema.contacts.id, link.contactId), isNull(schema.contacts.primaryCompanyId)))
      await linkContactCompany(tx, companyId, link.contactId)
    }

    // 5. Companies to create — onConflict(firm_id, normalized_name) then re-find within firm.
    const seedKeyToId = new Map<string, string>()
    for (const co of plan.companiesToCreate) {
      const id = createId()
      const inserted = await tx
        .insert(schema.orgCompanies)
        .values({
          id,
          userId,
          firmId,
          canonicalName: co.canonicalName,
          normalizedName: co.normalizedName,
          primaryDomain: co.primaryDomain,
          status: 'active',
          entityType: 'unknown',
          classificationSource: 'auto',
          lamport,
          createdAt: now,
          updatedAt: now,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .onConflictDoNothing({ target: [schema.orgCompanies.firmId, schema.orgCompanies.normalizedName] })
        .returning({ id: schema.orgCompanies.id })

      let companyId = inserted[0]?.id
      if (companyId) {
        stats.companiesCreated += 1
        for (const name of co.nameAliases) await insertAlias(tx, companyId, name, 'name', lamport, now)
        for (const dom of co.domainAliases) await insertAlias(tx, companyId, dom, 'domain', lamport, now)
      } else {
        const found = await tx
          .select({ id: schema.orgCompanies.id })
          .from(schema.orgCompanies)
          .where(and(eq(schema.orgCompanies.firmId, firmId), eq(schema.orgCompanies.normalizedName, co.normalizedName)))
          .limit(1)
        companyId = found[0]?.id
      }
      if (companyId) seedKeyToId.set(co.seedKey, companyId)
    }

    // 6. Meeting↔company links.
    for (const link of plan.meetingCompanyLinks) {
      const companyId = link.companyId ?? (link.seedKey ? seedKeyToId.get(link.seedKey) ?? null : null)
      if (!companyId) continue
      await tx
        .insert(schema.meetingCompanyLinks)
        .values({
          meetingId: link.meetingId,
          companyId,
          confidence: link.confidence,
          linkedBy: link.linkedBy,
          createdByUserId: userId,
          updatedByUserId: userId,
          lamport,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.meetingCompanyLinks.meetingId, schema.meetingCompanyLinks.companyId],
          set: {
            confidence: sql`greatest(${schema.meetingCompanyLinks.confidence}, excluded.confidence)`,
            linkedBy: sql`excluded.linked_by`,
            updatedByUserId: userId,
            lamport,
          },
        })
      stats.linksCreated += 1
    }

    // 7. Prune stale links.
    for (const prune of plan.companyLinksToPrune) {
      await tx
        .delete(schema.meetingCompanyLinks)
        .where(and(eq(schema.meetingCompanyLinks.meetingId, prune.meetingId), eq(schema.meetingCompanyLinks.companyId, prune.companyId)))
    }
  })

  return stats
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function domainOfEmail(email: string): string | null {
  return extractEmailDomain(email)
}

/** Firm-scoped company lookup by email domain — primary_domain, then domain alias. */
async function findCompanyIdByDomain(tx: Tx, domain: string | null, firmId: string): Promise<string | null> {
  if (!domain) return null
  const candidates = getDomainLookupCandidates(domain)
  if (candidates.length === 0) return null

  const byDomain = await tx
    .select({ id: schema.orgCompanies.id })
    .from(schema.orgCompanies)
    .where(
      and(eq(schema.orgCompanies.firmId, firmId), inArray(sql`lower(trim(${schema.orgCompanies.primaryDomain}))`, candidates)),
    )
    .limit(1)
  if (byDomain[0]) return byDomain[0].id

  const byAlias = await tx
    .select({ companyId: schema.orgCompanyAliases.companyId })
    .from(schema.orgCompanyAliases)
    .innerJoin(schema.orgCompanies, eq(schema.orgCompanies.id, schema.orgCompanyAliases.companyId))
    .where(
      and(
        eq(schema.orgCompanies.firmId, firmId),
        eq(schema.orgCompanyAliases.aliasType, 'domain'),
        inArray(sql`lower(trim(${schema.orgCompanyAliases.aliasValue}))`, candidates),
      ),
    )
    .limit(1)
  return byAlias[0]?.companyId ?? null
}

/** Set the contact↔company join (primary). Neon-local (not pulled) — keeps gateway/mobile reads correct. */
async function linkContactCompany(tx: Tx, companyId: string, contactId: string): Promise<void> {
  await tx
    .insert(schema.orgCompanyContacts)
    .values({ companyId, contactId, isPrimary: 1 })
    .onConflictDoUpdate({ target: [schema.orgCompanyContacts.companyId, schema.orgCompanyContacts.contactId], set: { isPrimary: 1 } })
}

async function insertAlias(
  tx: Tx,
  companyId: string,
  aliasValue: string,
  aliasType: 'name' | 'domain',
  lamport: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(schema.orgCompanyAliases)
    .values({ id: createId(), companyId, aliasValue, aliasType, lamport, createdAt: now })
    .onConflictDoNothing()
}
