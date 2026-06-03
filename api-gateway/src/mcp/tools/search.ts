// cyggie_search — universal search across companies, contacts, meetings, notes.
//
// Wraps the same query logic the GET /search REST route uses
// (api-gateway/src/routes/search.ts) and returns it as LLM-friendly
// markdown. Cheap (DB-only, no LLM) → safe for the LLM to call
// liberally during disambiguation.

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { ok, type ToolResult } from '../../shared/error-envelope'
import { cyggieUrl, formatDate, formatRecency } from '../format'

export interface CyggieSearchArgs {
  db: ReturnType<typeof getDb>
  userId: string
  query: string
  // Per-bucket result cap. 5 matches the REST route default; LLM can
  // raise to 20 for broader exploration.
  limit?: number
}

// Structured search result, separated from markdown formatting so
// non-MCP callers (the Slack `/cyggie search ...` handler in slice 2)
// can reuse the SQL without re-deriving the data shape.
export interface SearchResults {
  query: string
  companies: { items: CompanyHit[]; total: number }
  contacts: { items: ContactHit[]; total: number }
  meetings: { items: MeetingHit[]; total: number }
  notes: { items: NoteHit[]; total: number }
}

const MAX_LIMIT = 20

function buildPreview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= 160) return flat
  return flat.slice(0, 157) + '…'
}

export async function runCyggieSearch(
  args: CyggieSearchArgs,
): Promise<SearchResults> {
  const { db, userId, query } = args
  const limit = Math.min(args.limit ?? 5, MAX_LIMIT)
  const trimmed = query.trim()

  if (!trimmed) {
    return {
      query: '',
      companies: { items: [], total: 0 },
      contacts: { items: [], total: 0 },
      meetings: { items: [], total: 0 },
      notes: { items: [], total: 0 },
    }
  }

  // Run all four lookups in parallel — same pattern as the REST route.
  const [companies, contacts, meetings, notes] = await Promise.all([
    searchCompanies(db, userId, trimmed, limit),
    searchContacts(db, userId, trimmed, limit),
    searchMeetings(db, userId, trimmed, limit),
    searchNotes(db, userId, trimmed, limit),
  ])

  return { query: trimmed, companies, contacts, meetings, notes }
}

export async function cyggieSearch(args: CyggieSearchArgs): Promise<ToolResult> {
  const results = await runCyggieSearch(args)
  const { query, companies, contacts, meetings, notes } = results
  const trimmed = query

  if (!trimmed) return ok('No query provided.')

  const totalHits =
    companies.total + contacts.total + meetings.total + notes.total
  if (totalHits === 0) {
    return ok(`No matches for "${trimmed}".`)
  }

  const sections: string[] = [`## Search results for "${trimmed}"`]

  if (companies.items.length > 0) {
    sections.push(
      sectionHeader('Companies', companies.items.length, companies.total) +
        '\n' +
        companies.items.map((c) => renderCompanyHit(c)).join('\n'),
    )
  }
  if (contacts.items.length > 0) {
    sections.push(
      sectionHeader('Contacts', contacts.items.length, contacts.total) +
        '\n' +
        contacts.items.map((c) => renderContactHit(c)).join('\n'),
    )
  }
  if (meetings.items.length > 0) {
    sections.push(
      sectionHeader('Meetings', meetings.items.length, meetings.total) +
        '\n' +
        meetings.items.map((m) => renderMeetingHit(m)).join('\n'),
    )
  }
  if (notes.items.length > 0) {
    sections.push(
      sectionHeader('Notes', notes.items.length, notes.total) +
        '\n' +
        notes.items.map((n) => renderNoteHit(n)).join('\n'),
    )
  }

  return ok(sections.join('\n\n'))
}

function sectionHeader(label: string, shown: number, total: number): string {
  const counter = total > shown ? `${shown} of ${total}` : `${shown}`
  return `### ${label} (${counter})`
}

export interface CompanyHit {
  id: string
  name: string
  industry: string | null
  pipelineStage: string | null
  primaryDomain: string | null
}
function renderCompanyHit(c: CompanyHit): string {
  const meta = [c.industry, c.pipelineStage].filter(Boolean).join(' · ')
  const domain = c.primaryDomain ? ` (${c.primaryDomain})` : ''
  return `- **${c.name}**${domain}${meta ? ` — ${meta}` : ''} [${cyggieUrl('company', c.id)}]`
}

export interface ContactHit {
  id: string
  fullName: string
  title: string | null
  email: string | null
  primaryCompanyName: string | null
}
function renderContactHit(c: ContactHit): string {
  const at = c.primaryCompanyName ? ` @ ${c.primaryCompanyName}` : ''
  const meta = [c.title, c.email].filter(Boolean).join(' · ')
  return `- **${c.fullName}**${at}${meta ? ` — ${meta}` : ''} [${cyggieUrl('contact', c.id)}]`
}

export interface MeetingHit {
  id: string
  title: string
  date: Date
}
function renderMeetingHit(m: MeetingHit): string {
  const d = formatDate(m.date)
  const rel = formatRecency(m.date)
  const dateBit = d && rel ? `${d} (${rel})` : (d ?? rel ?? '')
  return `- **${m.title}**${dateBit ? ` — ${dateBit}` : ''} [${cyggieUrl('meeting', m.id)}]`
}

export interface NoteHit {
  id: string
  title: string | null
  contentPreview: string
  companyName: string | null
  contactName: string | null
  updatedAt: Date
}
function renderNoteHit(n: NoteHit): string {
  const title = n.title ?? '(untitled note)'
  const attached = [n.companyName, n.contactName].filter(Boolean).join(' / ')
  const rel = formatRecency(n.updatedAt)
  const tail = [attached, rel].filter(Boolean).join(' · ')
  return `- **${title}**${tail ? ` — ${tail}` : ''}\n  > ${n.contentPreview} [${cyggieUrl('note', n.id)}]`
}

// ─── Query helpers ────────────────────────────────────────────────────────
// Mirror the SQL from api-gateway/src/routes/search.ts. Kept as discrete
// functions for testability; could lift the REST route to call into
// these as a follow-up if the route ever wants the same markdown output.

async function searchCompanies(
  db: ReturnType<typeof getDb>,
  userId: string,
  q: string,
  limit: number,
): Promise<{ items: CompanyHit[]; total: number }> {
  const where = and(
    eq(schema.orgCompanies.userId, userId),
    ilike(schema.orgCompanies.canonicalName, `%${q}%`),
  )
  const [items, countRow] = await Promise.all([
    db
      .select({
        id: schema.orgCompanies.id,
        name: schema.orgCompanies.canonicalName,
        industry: schema.orgCompanies.industry,
        pipelineStage: schema.orgCompanies.pipelineStage,
        primaryDomain: schema.orgCompanies.primaryDomain,
      })
      .from(schema.orgCompanies)
      .where(where)
      .orderBy(schema.orgCompanies.canonicalName)
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orgCompanies)
      .where(where),
  ])
  return { items, total: countRow[0]?.n ?? 0 }
}

async function searchContacts(
  db: ReturnType<typeof getDb>,
  userId: string,
  q: string,
  limit: number,
): Promise<{ items: ContactHit[]; total: number }> {
  const where = and(
    eq(schema.contacts.userId, userId),
    or(
      ilike(schema.contacts.fullName, `%${q}%`),
      ilike(schema.contacts.email, `%${q}%`),
    ),
  )
  const [items, countRow] = await Promise.all([
    db
      .select({
        id: schema.contacts.id,
        fullName: schema.contacts.fullName,
        title: schema.contacts.title,
        email: schema.contacts.email,
        primaryCompanyName: schema.orgCompanies.canonicalName,
      })
      .from(schema.contacts)
      .leftJoin(
        schema.orgCompanies,
        eq(schema.contacts.primaryCompanyId, schema.orgCompanies.id),
      )
      .where(where)
      .orderBy(schema.contacts.fullName)
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.contacts)
      .where(where),
  ])
  return { items, total: countRow[0]?.n ?? 0 }
}

async function searchMeetings(
  db: ReturnType<typeof getDb>,
  userId: string,
  q: string,
  limit: number,
): Promise<{ items: MeetingHit[]; total: number }> {
  const where = and(
    eq(schema.meetings.userId, userId),
    ilike(schema.meetings.title, `%${q}%`),
  )
  const [items, countRow] = await Promise.all([
    db
      .select({
        id: schema.meetings.id,
        title: schema.meetings.title,
        date: schema.meetings.date,
      })
      .from(schema.meetings)
      .where(where)
      .orderBy(desc(schema.meetings.date))
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.meetings)
      .where(where),
  ])
  return {
    items: items.map((m) => ({ id: m.id, title: m.title, date: new Date(m.date) })),
    total: countRow[0]?.n ?? 0,
  }
}

async function searchNotes(
  db: ReturnType<typeof getDb>,
  userId: string,
  q: string,
  limit: number,
): Promise<{ items: NoteHit[]; total: number }> {
  const where = and(
    eq(schema.notes.userId, userId),
    sql`to_tsvector('english', coalesce(${schema.notes.title}, '') || ' ' || substring(${schema.notes.content} from 1 for 500000)) @@ plainto_tsquery('english', ${q})`,
  )
  const [items, countRow] = await Promise.all([
    db
      .select({
        id: schema.notes.id,
        title: schema.notes.title,
        content: schema.notes.content,
        companyName: schema.orgCompanies.canonicalName,
        contactName: schema.contacts.fullName,
        updatedAt: schema.notes.updatedAt,
      })
      .from(schema.notes)
      .leftJoin(
        schema.orgCompanies,
        eq(schema.notes.companyId, schema.orgCompanies.id),
      )
      .leftJoin(schema.contacts, eq(schema.notes.contactId, schema.contacts.id))
      .where(where)
      .orderBy(desc(schema.notes.updatedAt))
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.notes)
      .where(where),
  ])
  return {
    items: items.map((n) => ({
      id: n.id,
      title: n.title,
      contentPreview: buildPreview(n.content ?? ''),
      companyName: n.companyName,
      contactName: n.contactName,
      updatedAt: new Date(n.updatedAt),
    })),
    total: countRow[0]?.n ?? 0,
  }
}
