// Fuzzy resolver for company / contact lookups by free-form name or id.
//
// Per External Agents V1 plan Q9, the resolver follows this rule set:
//
//   1. If the query looks like a cuid2 id, try direct id lookup first.
//   2. Try exact match on normalized_name (case-folded, accent-stripped).
//      • 1 match → resolve immediately.
//      • 2+ matches → return all as candidates (HARD RULE: never
//        auto-resolve when multiple records share a normalized name —
//        ambiguous by definition).
//      • 0 matches → fall through.
//   3. Try ILIKE substring match on canonical_name (or fullName/email).
//      • 1 match → resolve to that.
//      • 2-5 matches → return candidates, ranked by recency.
//      • 6+ matches → return top 5 candidates, ranked by recency.
//      • 0 matches → return none.
//
// Recency tiebreak:
//   companies: updated_at DESC (active companies bubble up).
//   contacts:  COALESCE(last_meeting_at, last_email_at, updated_at) DESC.
//
// Caller pattern:
//   const r = await resolveCompany({ db, userId, query: 'acme' })
//   if (r.kind === 'single') ...
//   if (r.kind === 'candidates') ... // render disambig list
//   if (r.kind === 'none') ...

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../db'

// A cuid2 is 24 lowercase alphanumeric chars. Treat anything matching
// that shape as an id; everything else is a name query. Misclassification
// is bounded: a 24-char company *name* that happens to match the regex
// would route to id lookup and miss (no row), then we'd return NONE
// rather than fall through to name lookup. Acceptable — names that
// happen to be 24 alphanumeric chars are vanishingly rare in CRM data.
const CUID2_REGEX = /^[a-z0-9]{24}$/

function looksLikeId(s: string): boolean {
  return CUID2_REGEX.test(s.trim())
}

// Lowercase + trim + accent strip — matches the desktop's normalization
// used to populate normalized_name columns (see packages/services).
// Using Unicode NFKD + combining-mark strip is the standard approach.
function normalizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

// ─── Companies ────────────────────────────────────────────────────────────

export interface CompanyCandidate {
  id: string
  canonicalName: string
  industry: string | null
  stage: string | null
  pipelineStage: string | null
  primaryDomain: string | null
  // Recency proxy for ranking + LLM disambig context. Falls back through
  // multiple signals so a company that was edited recently bubbles up
  // even if it has no meetings yet.
  lastTouchedAt: Date | null
}

export type ResolveCompanyResult =
  | { kind: 'single'; company: CompanyCandidate }
  | { kind: 'candidates'; companies: CompanyCandidate[] }
  | { kind: 'none' }

const COMPANY_COLUMNS = {
  id: schema.orgCompanies.id,
  canonicalName: schema.orgCompanies.canonicalName,
  industry: schema.orgCompanies.industry,
  stage: schema.orgCompanies.stage,
  pipelineStage: schema.orgCompanies.pipelineStage,
  primaryDomain: schema.orgCompanies.primaryDomain,
  lastTouchedAt: schema.orgCompanies.updatedAt,
}

export async function resolveCompany(args: {
  db: ReturnType<typeof getDb>
  userId: string
  query: string
}): Promise<ResolveCompanyResult> {
  const { db, userId, query } = args
  const trimmed = query.trim()
  if (!trimmed) return { kind: 'none' }

  // 1. Id path.
  if (looksLikeId(trimmed)) {
    const rows = await db
      .select(COMPANY_COLUMNS)
      .from(schema.orgCompanies)
      .where(
        and(
          eq(schema.orgCompanies.userId, userId),
          eq(schema.orgCompanies.id, trimmed),
        ),
      )
      .limit(1)
    if (rows[0]) return { kind: 'single', company: toCompanyCandidate(rows[0]) }
    return { kind: 'none' }
  }

  const normalized = normalizeName(trimmed)

  // 2. Exact normalized-name match.
  const exact = await db
    .select(COMPANY_COLUMNS)
    .from(schema.orgCompanies)
    .where(
      and(
        eq(schema.orgCompanies.userId, userId),
        eq(schema.orgCompanies.normalizedName, normalized),
      ),
    )
    // No LIMIT — we WANT to know if there's more than one (HARD RULE).
    .orderBy(desc(schema.orgCompanies.updatedAt))
  if (exact.length === 1) return { kind: 'single', company: toCompanyCandidate(exact[0]) }
  if (exact.length > 1) {
    return { kind: 'candidates', companies: exact.map(toCompanyCandidate) }
  }

  // 3. ILIKE substring fallback.
  const fuzzy = await db
    .select(COMPANY_COLUMNS)
    .from(schema.orgCompanies)
    .where(
      and(
        eq(schema.orgCompanies.userId, userId),
        ilike(schema.orgCompanies.canonicalName, `%${trimmed}%`),
      ),
    )
    .orderBy(desc(schema.orgCompanies.updatedAt))
    .limit(5)
  if (fuzzy.length === 0) return { kind: 'none' }
  if (fuzzy.length === 1) return { kind: 'single', company: toCompanyCandidate(fuzzy[0]) }
  return { kind: 'candidates', companies: fuzzy.map(toCompanyCandidate) }
}

function toCompanyCandidate(
  row: typeof COMPANY_COLUMNS extends Record<string, infer _> ? Record<string, unknown> : never,
): CompanyCandidate {
  // Drizzle's select with an object map returns the same keys typed
  // correctly. Cast is safe because we built COMPANY_COLUMNS ourselves.
  const r = row as {
    id: string
    canonicalName: string
    industry: string | null
    stage: string | null
    pipelineStage: string | null
    primaryDomain: string | null
    lastTouchedAt: Date
  }
  return {
    id: r.id,
    canonicalName: r.canonicalName,
    industry: r.industry,
    stage: r.stage,
    pipelineStage: r.pipelineStage,
    primaryDomain: r.primaryDomain,
    lastTouchedAt: r.lastTouchedAt ?? null,
  }
}

// ─── Contacts ─────────────────────────────────────────────────────────────

export interface ContactCandidate {
  id: string
  fullName: string
  title: string | null
  email: string | null
  primaryCompanyId: string | null
  // Best-available recency: meeting > email > updated. NULL if all three
  // are missing (a contact created but never touched).
  lastTouchedAt: Date | null
}

export type ResolveContactResult =
  | { kind: 'single'; contact: ContactCandidate }
  | { kind: 'candidates'; contacts: ContactCandidate[] }
  | { kind: 'none' }

const CONTACT_COLUMNS = {
  id: schema.contacts.id,
  fullName: schema.contacts.fullName,
  title: schema.contacts.title,
  email: schema.contacts.email,
  primaryCompanyId: schema.contacts.primaryCompanyId,
  lastMeetingAt: schema.contacts.lastMeetingAt,
  lastEmailAt: schema.contacts.lastEmailAt,
  updatedAt: schema.contacts.updatedAt,
}

// COALESCE(last_meeting_at, last_email_at, updated_at) — composite recency
// for ordering. Expressed as a Drizzle sql<Date> so we can pass it to
// orderBy.
const CONTACT_RECENCY = sql<Date>`COALESCE(${schema.contacts.lastMeetingAt}, ${schema.contacts.lastEmailAt}, ${schema.contacts.updatedAt})`

export async function resolveContact(args: {
  db: ReturnType<typeof getDb>
  userId: string
  query: string
}): Promise<ResolveContactResult> {
  const { db, userId, query } = args
  const trimmed = query.trim()
  if (!trimmed) return { kind: 'none' }

  // 1. Id path.
  if (looksLikeId(trimmed)) {
    const rows = await db
      .select(CONTACT_COLUMNS)
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.userId, userId),
          eq(schema.contacts.id, trimmed),
        ),
      )
      .limit(1)
    if (rows[0]) return { kind: 'single', contact: toContactCandidate(rows[0]) }
    return { kind: 'none' }
  }

  // 2. Exact-match path. For contacts we check BOTH normalized_name AND
  // email (unique). Email match is unambiguous; name match might have
  // duplicates (e.g. two "John Smith"s) — hard rule applies.
  const lower = trimmed.toLowerCase()
  if (lower.includes('@')) {
    const byEmail = await db
      .select(CONTACT_COLUMNS)
      .from(schema.contacts)
      .where(and(eq(schema.contacts.userId, userId), eq(schema.contacts.email, lower)))
      .limit(1)
    if (byEmail[0]) return { kind: 'single', contact: toContactCandidate(byEmail[0]) }
    // Email didn't match — fall through to name search (rare: user
    // pasted an email that's not in CRM).
  }

  const normalized = normalizeName(trimmed)
  const exact = await db
    .select(CONTACT_COLUMNS)
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.userId, userId),
        eq(schema.contacts.normalizedName, normalized),
      ),
    )
    .orderBy(desc(CONTACT_RECENCY))
  if (exact.length === 1) return { kind: 'single', contact: toContactCandidate(exact[0]) }
  if (exact.length > 1) {
    return { kind: 'candidates', contacts: exact.map(toContactCandidate) }
  }

  // 3. ILIKE substring fallback on fullName or email.
  const fuzzy = await db
    .select(CONTACT_COLUMNS)
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.userId, userId),
        or(
          ilike(schema.contacts.fullName, `%${trimmed}%`),
          ilike(schema.contacts.email, `%${trimmed}%`),
        ),
      ),
    )
    .orderBy(desc(CONTACT_RECENCY))
    .limit(5)
  if (fuzzy.length === 0) return { kind: 'none' }
  if (fuzzy.length === 1) return { kind: 'single', contact: toContactCandidate(fuzzy[0]) }
  return { kind: 'candidates', contacts: fuzzy.map(toContactCandidate) }
}

function toContactCandidate(row: Record<string, unknown>): ContactCandidate {
  const r = row as {
    id: string
    fullName: string
    title: string | null
    email: string | null
    primaryCompanyId: string | null
    lastMeetingAt: Date | null
    lastEmailAt: Date | null
    updatedAt: Date
  }
  return {
    id: r.id,
    fullName: r.fullName,
    title: r.title,
    email: r.email,
    primaryCompanyId: r.primaryCompanyId,
    lastTouchedAt: r.lastMeetingAt ?? r.lastEmailAt ?? r.updatedAt ?? null,
  }
}

// ─── Exported helpers for tests / observability ───────────────────────────

export const _internals = {
  looksLikeId,
  normalizeName,
  CUID2_REGEX,
}
