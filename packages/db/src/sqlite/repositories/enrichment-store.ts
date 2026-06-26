// SqliteEnrichmentStore — desktop's persister for the shared meeting-enrichment
// planner (T3 Slice 0, Part 2). The planner (`packages/db/src/meeting-enrichment/
// plan.ts`) makes every DECISION purely in memory and emits a WritePlan; this file
// is the desktop SIDE EFFECT: it (a) BATCH-loads the existing CRM state the planner
// needs, and (b) APPLIES a WritePlan to SQLite + the sync outbox, reusing the exact
// primitives the old inline `applyCandidates` / `syncMeetingCompanyLinks` used so
// the rows + outbox are byte-for-byte identical (proven by enrichment-store-parity).
//
// Concrete, no interface (eng-review 3A) — the gateway's `PgEnrichmentStore` is a
// separate Slice-1 concern. Lives inside repositories/ so it may import the sibling
// repos' raw primitives directly (check-repo-imports exempts this dir); the
// store ⇄ repo cycle is lazy (every cross-reference is call-time, never top-level).
//
// What the planner DEFERS to this persister (it can't model these purely):
//   • contact→primary-company link (findCompanyIdByEmail is a DB read at apply time)
//   • desktop soft-delete tombstone skip on create (migration 098)
//   • outbox/lamport stamping (emitNewContact / createCompanyForMeeting / link emit)
// Desktop also does NOT persist meeting↔contact links, so the planner's
// `meetingContactLinks` is used ONLY to locate existing matches for the deferred
// email-attach + company-link — never written as link rows.
//
//   loadContactExistingState ─▶ planContacts/planContactDecisions ─▶ applyContactWritePlan
//   loadCompanyExistingState ─▶ planCompanyLinks                  ─▶ applyCompanyWritePlan
//
// applyContactWritePlan pipeline (dependency-ordered, one transaction):
//   contactsToCreate ─(tombstone-skip)─▶ insert + attach + company-link + emit
//   contactNameUpdates ─▶ updateContact
//   meetingContactLinks(existing) ─▶ primary-email backfill + attach + company-link
//
// applyCompanyWritePlan pipeline (resolve seedKey→new id, then link/prune):
//   companiesToCreate ─▶ createCompanyForMeeting → seedKey→id
//   meetingCompanyLinks ─(companyId ?? seedKey→id)─▶ link upsert + emit
//   companyLinksToPrune ─▶ capture-before-delete + emit delete

import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import { appendOutboxRow, currentSyncContext } from '../sync-wrapper'
import { attachEmailToContact, ensurePrimaryCompanyLink, findCompanyIdByEmail } from './contact.repo'
import { createCompanyForMeeting } from './meeting.repo'
import {
  extractEmailDomain,
  getDomainLookupCandidates,
  getRegistrableDomain,
  normalizeCompanyName,
  normalizeEmail,
} from '../../meeting-enrichment/helpers'
import type {
  CompanyPlan,
  ContactPlan,
  ExistingCompany,
  ExistingContact,
  ExistingState,
} from '../../meeting-enrichment/plan'

const SQLITE_VARS_PER_CHUNK = 500 // stay under SQLite's 999-variable bind limit

function* chunk<T>(items: T[], size = SQLITE_VARS_PER_CHUNK): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

/** Everything applyContactWritePlan needs that the pure ContactPlan can't carry. */
export interface ContactLoadedState {
  /** keyed by normalized email → its owning contact (matched by primary OR secondary email). */
  contactsByEmail: Map<string, ExistingContact>
  /** tombstoned emails among the candidates (migration 098 — gate create-new only). */
  tombstoned: Set<string>
  /** contact id → its primary_company_id (drives the existing-contact company-link backfill). */
  primaryCompanyByContactId: Map<string, string | null>
}

interface ContactRow {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  normalized_name: string
  email: string | null
  primary_company_id: string | null
}

/**
 * BATCH-load existing contacts for a candidate email set (fixes the old per-candidate
 * `getByEmail` N+1). Keys each candidate email to its contact, matching by primary
 * email first then secondary `contact_emails` — the same precedence as the original
 * `lower(c.email)=? OR EXISTS(contact_emails …)` lookup. Also bulk-loads the tombstone
 * set and each matched contact's primary_company_id.
 */
export function loadContactExistingState(emails: string[]): ContactLoadedState {
  const db = getDatabase()
  const contactsByEmail = new Map<string, ExistingContact>()
  const primaryCompanyByContactId = new Map<string, string | null>()
  const tombstoned = new Set<string>()

  const uniqueEmails = [...new Set(emails.filter((e): e is string => Boolean(e)))]
  if (uniqueEmails.length === 0) {
    return { contactsByEmail, tombstoned, primaryCompanyByContactId }
  }

  const ingest = (matchEmail: string, row: ContactRow): void => {
    // First writer wins: the primary-email pass runs before the secondary pass, so a
    // primary match is never clobbered by a secondary match for the same email.
    if (contactsByEmail.has(matchEmail)) return
    contactsByEmail.set(matchEmail, {
      id: row.id,
      fullName: row.full_name,
      normalizedName: row.normalized_name,
      firstName: row.first_name,
      lastName: row.last_name,
      primaryEmail: row.email,
    })
    primaryCompanyByContactId.set(row.id, row.primary_company_id ?? null)
  }

  for (const part of chunk(uniqueEmails)) {
    const placeholders = part.map(() => '?').join(',')

    const byPrimary = db
      .prepare(
        `SELECT id, full_name, first_name, last_name, normalized_name, email, primary_company_id
         FROM contacts WHERE lower(email) IN (${placeholders})`,
      )
      .all(...part) as ContactRow[]
    for (const row of byPrimary) ingest(normalizeEmail(row.email ?? '') ?? '', row)

    const bySecondary = db
      .prepare(
        `SELECT c.id, c.full_name, c.first_name, c.last_name, c.normalized_name, c.email, c.primary_company_id,
                lower(ce.email) AS match_email
         FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
         WHERE lower(ce.email) IN (${placeholders})`,
      )
      .all(...part) as Array<ContactRow & { match_email: string }>
    for (const row of bySecondary) ingest(row.match_email, row)

    const tombRows = db
      .prepare(`SELECT email FROM contact_tombstones WHERE email IN (${placeholders})`)
      .all(...part) as Array<{ email: string }>
    for (const r of tombRows) tombstoned.add(r.email)
  }

  return { contactsByEmail, tombstoned, primaryCompanyByContactId }
}

/** Stamp + emit a NEWLY-created contact and its contact_emails (port of applyCandidates' emitNewContact). */
function emitNewContact(db: ReturnType<typeof getDatabase>, contactId: string): void {
  const ctx = currentSyncContext()
  if (!ctx) return // offline / pre-login / raw-test: no emission (and no lamport column touch)
  db.prepare('UPDATE contacts SET lamport = ? WHERE id = ?').run(ctx.lamport, contactId)
  const contactRow = db
    .prepare('SELECT * FROM contacts WHERE id = ?')
    .get(contactId) as Record<string, unknown> | undefined
  if (contactRow) appendOutboxRow(db, { table: 'contacts', op: 'insert', row: contactRow })
  const emailRows = db
    .prepare('SELECT * FROM contact_emails WHERE contact_id = ?')
    .all(contactId) as Array<Record<string, unknown>>
  for (const er of emailRows) {
    db.prepare('UPDATE contact_emails SET lamport = ? WHERE contact_id = ? AND email = ?').run(
      ctx.lamport,
      er['contact_id'],
      er['email'],
    )
    appendOutboxRow(db, { table: 'contact_emails', op: 'insert', row: { ...er, lamport: ctx.lamport } })
  }
}

export interface ContactApplyStats {
  inserted: number
  updated: number
  skipped: number
}

/**
 * Apply a ContactPlan to SQLite + outbox, reproducing the old applyCandidates writes
 * exactly. Wrapped in one transaction (the barrel's runInSyncBatch nests it via a
 * savepoint when a sync context is active; raw test callers get the lone tx).
 */
export function applyContactWritePlan(
  plan: ContactPlan,
  opts: { userId: string | null; loaded: ContactLoadedState },
): ContactApplyStats {
  const db = getDatabase()
  const { userId, loaded } = opts
  const stats: ContactApplyStats = { inserted: 0, updated: 0, skipped: 0 }

  const insertContact = db.prepare(`
    INSERT INTO contacts (
      id, full_name, first_name, last_name, normalized_name, email, primary_company_id,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const updateContact = db.prepare(`
    UPDATE contacts
    SET full_name = ?, first_name = ?, last_name = ?, normalized_name = ?,
        updated_by_user_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `)
  const updateContactPrimaryEmail = db.prepare(`
    UPDATE contacts
    SET email = ?, updated_by_user_id = ?, updated_at = datetime('now')
    WHERE id = ? AND (email IS NULL OR TRIM(email) = '')
  `)

  const apply = db.transaction(() => {
    // 1. New contacts — tombstone-skip (mig 098), then insert + attach + infer
    //    primary company + emit. Order matters: ensurePrimaryCompanyLink runs before
    //    emitNewContact so the emitted contacts row already carries primary_company_id
    //    (the insert sets it; ensurePrimaryCompanyLink only adds org_company_contacts).
    for (const c of plan.contactsToCreate) {
      if (loaded.tombstoned.has(c.email)) {
        console.debug(`[contact:tombstone-skip] email=${c.email} metric=contact.tombstone.skip count=1`)
        stats.skipped += 1
        continue
      }
      const contactId = randomUUID()
      const inferredCompanyId = findCompanyIdByEmail(c.email)
      insertContact.run(
        contactId,
        c.fullName,
        c.firstName,
        c.lastName,
        c.normalizedName,
        c.email,
        inferredCompanyId,
        userId,
        userId,
      )
      attachEmailToContact(db, contactId, c.email, true)
      if (inferredCompanyId) ensurePrimaryCompanyLink(db, contactId, inferredCompanyId, userId)
      emitNewContact(db, contactId)
      stats.inserted += 1
    }

    // 2. Name upgrades on existing contacts.
    const nameUpdated = new Set<string>()
    for (const u of plan.contactNameUpdates) {
      updateContact.run(u.fullName, u.firstName, u.lastName, u.normalizedName, userId, u.contactId)
      nameUpdated.add(u.contactId)
      stats.updated += 1
    }

    // 3. The deferred per-existing-contact work applyCandidates did unconditionally in
    //    its existing branch: primary-email backfill, contact_emails attach, and the
    //    contact→primary-company link. Driven off meetingContactLinks(existing); the
    //    links themselves are NOT persisted (desktop has no meeting↔contact link table).
    for (const link of plan.meetingContactLinks) {
      if (!link.contactId) continue // a to-be-created contact — handled in step 1
      const existing = loaded.contactsByEmail.get(link.email)
      if (!existing) continue
      if (!nameUpdated.has(link.contactId)) stats.skipped += 1 // mirror applyCandidates' else-branch

      if (!existing.primaryEmail || !existing.primaryEmail.trim()) {
        updateContactPrimaryEmail.run(link.email, userId, link.contactId)
      }
      attachEmailToContact(
        db,
        link.contactId,
        link.email,
        !existing.primaryEmail || normalizeEmail(existing.primaryEmail) === link.email,
      )
      if (!loaded.primaryCompanyByContactId.get(link.contactId)) {
        const inferredCompanyId = findCompanyIdByEmail(link.email)
        if (inferredCompanyId) ensurePrimaryCompanyLink(db, link.contactId, inferredCompanyId, userId)
      }
    }
  })

  apply()
  return stats
}

// ─── COMPANIES ───────────────────────────────────────────────────────────────

interface CompanyRow {
  id: string
  canonical_name: string
  normalized_name: string
  primary_domain: string | null
}

/**
 * BATCH-load the CANDIDATE companies for a meeting — never the whole table (the
 * planner contract). Fetches by seed normalized-names, name aliases, and attendee
 * email domains (primary-domain + domain aliases), then hydrates each with its
 * aliases so the in-memory `matchExistingCompany` reproduces findExistingCompanyId.
 * Also loads the meeting's current company-link ids (drives the prune).
 */
export function loadCompanyExistingState(
  meetingId: string,
  seedNames: string[],
  attendeeEmails: string[] | null | undefined,
): ExistingState {
  const db = getDatabase()
  const ids = new Set<string>()

  const normSeeds = [...new Set(seedNames.map((n) => normalizeCompanyName(n)).filter(Boolean))]
  for (const part of chunk(normSeeds)) {
    const ph = part.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT id FROM org_companies WHERE normalized_name IN (${ph})`)
      .all(...part) as Array<{ id: string }>
    for (const r of rows) ids.add(r.id)
  }

  const nameKeys = [...new Set(seedNames.map((n) => n.trim().toLowerCase()).filter(Boolean))]
  for (const part of chunk(nameKeys)) {
    const ph = part.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT company_id FROM org_company_aliases
         WHERE alias_type = 'name' AND lower(trim(alias_value)) IN (${ph})`,
      )
      .all(...part) as Array<{ company_id: string }>
    for (const r of rows) ids.add(r.company_id)
  }

  // Attendee-email domain candidates (mirrors findExistingCompanyId's domain set).
  const domainCandidates = new Set<string>()
  for (const email of attendeeEmails || []) {
    const domain = extractEmailDomain(email)
    if (!domain) continue
    for (const base of [domain, getRegistrableDomain(domain)]) {
      for (const cand of getDomainLookupCandidates(base)) domainCandidates.add(cand)
    }
  }
  const domainList = [...domainCandidates]
  for (const part of chunk(domainList)) {
    const ph = part.map(() => '?').join(',')
    // primary domain (raw OR www-stripped) — getDomainLookupCandidates already
    // includes the www. variant, so a direct IN covers both stored forms.
    const byDomain = db
      .prepare(
        `SELECT id FROM org_companies
         WHERE lower(trim(primary_domain)) IN (${ph})
            OR (CASE WHEN lower(trim(primary_domain)) LIKE 'www.%'
                     THEN substr(lower(trim(primary_domain)), 5)
                     ELSE lower(trim(primary_domain)) END) IN (${ph})`,
      )
      .all(...part, ...part) as Array<{ id: string }>
    for (const r of byDomain) ids.add(r.id)
    const byAlias = db
      .prepare(
        `SELECT company_id FROM org_company_aliases
         WHERE alias_type = 'domain' AND lower(trim(alias_value)) IN (${ph})`,
      )
      .all(...part) as Array<{ company_id: string }>
    for (const r of byAlias) ids.add(r.company_id)
  }

  const companies: ExistingCompany[] = []
  for (const part of chunk([...ids])) {
    const ph = part.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, canonical_name, normalized_name, primary_domain FROM org_companies WHERE id IN (${ph})`,
      )
      .all(...part) as CompanyRow[]
    for (const row of rows) {
      const aliases = db
        .prepare('SELECT alias_value, alias_type FROM org_company_aliases WHERE company_id = ?')
        .all(row.id) as Array<{ alias_value: string; alias_type: string }>
      companies.push({
        id: row.id,
        canonicalName: row.canonical_name,
        normalizedName: row.normalized_name,
        primaryDomain: row.primary_domain,
        nameAliases: aliases.filter((a) => a.alias_type === 'name').map((a) => a.alias_value),
        domainAliases: aliases.filter((a) => a.alias_type === 'domain').map((a) => a.alias_value),
      })
    }
  }

  const currentMeetingCompanyLinkIds = (
    db
      .prepare('SELECT company_id FROM meeting_company_links WHERE meeting_id = ? ORDER BY rowid ASC')
      .all(meetingId) as Array<{ company_id: string }>
  ).map((r) => r.company_id)

  return { contactsByEmail: new Map(), companies, currentMeetingCompanyLinkIds }
}

/**
 * Apply a CompanyPlan to SQLite + outbox, reproducing syncMeetingCompanyLinks. Creates
 * the planned companies (capturing seedKey→new id), upserts + emits each meeting↔company
 * link, then prunes stale links with capture-before-delete. Runs directly (no nested
 * transaction — it executes inside the wrapped createMeeting/updateMeeting tx, exactly
 * as the original did).
 */
export function applyCompanyWritePlan(
  plan: CompanyPlan,
  opts: {
    userId: string | null
    attendeeEmails: string[] | null | undefined
    confidence: number
    linkedBy: string
  },
): void {
  const db = getDatabase()
  const { userId, attendeeEmails, confidence, linkedBy } = opts
  const ctx = currentSyncContext()
  const lamport = ctx?.lamport ?? '0'

  const seedKeyToId = new Map<string, string>()
  for (const c of plan.companiesToCreate) {
    const id = createCompanyForMeeting(db, c.canonicalName, attendeeEmails, userId)
    if (id) seedKeyToId.set(c.seedKey, id)
  }

  for (const link of plan.meetingCompanyLinks) {
    const companyId = link.companyId ?? (link.seedKey ? seedKeyToId.get(link.seedKey) ?? null : null)
    if (!companyId) continue
    db.prepare(`
      INSERT INTO meeting_company_links (
        meeting_id, company_id, confidence, linked_by, created_by_user_id, updated_by_user_id, lamport, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(meeting_id, company_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > meeting_company_links.confidence THEN excluded.confidence
          ELSE meeting_company_links.confidence
        END,
        linked_by = excluded.linked_by,
        updated_by_user_id = excluded.updated_by_user_id,
        lamport = excluded.lamport
    `).run(link.meetingId, companyId, confidence, linkedBy, userId, userId, lamport)

    if (ctx) {
      const linkRow = db
        .prepare('SELECT * FROM meeting_company_links WHERE meeting_id = ? AND company_id = ?')
        .get(link.meetingId, companyId) as Record<string, unknown> | undefined
      if (linkRow) appendOutboxRow(db, { table: 'meeting_company_links', op: 'insert', row: linkRow })
    }
  }

  // Prune stale links. Capture each doomed row BEFORE delete so the tombstone replicates.
  for (const prune of plan.companyLinksToPrune) {
    if (ctx) {
      const doomed = db
        .prepare('SELECT * FROM meeting_company_links WHERE meeting_id = ? AND company_id = ?')
        .get(prune.meetingId, prune.companyId) as Record<string, unknown> | undefined
      db.prepare('DELETE FROM meeting_company_links WHERE meeting_id = ? AND company_id = ?').run(
        prune.meetingId,
        prune.companyId,
      )
      if (doomed) appendOutboxRow(db, { table: 'meeting_company_links', op: 'delete', row: doomed })
    } else {
      db.prepare('DELETE FROM meeting_company_links WHERE meeting_id = ? AND company_id = ?').run(
        prune.meetingId,
        prune.companyId,
      )
    }
  }
}
