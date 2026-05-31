// cyggie_get_notes — list notes attached to a company / contact / meeting,
// or matching an FTS query. At least one filter is required (else the
// LLM could trivially exfiltrate the entire note table — and the result
// would be too big to be useful anyway).

import { and, desc, eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import { cyggieUrl, formatDate, formatRecency } from '../format'

export interface CyggieGetNotesArgs {
  db: ReturnType<typeof getDb>
  userId: string
  companyId?: string
  contactId?: string
  meetingId?: string
  // Free-form FTS query. Combinable with attachment filters
  // (e.g. "notes on Acme that mention 'term sheet'").
  query?: string
  // Default 10, max 25. Notes are read often (preview a few),
  // not opened one-at-a-time, so a higher default than meetings.
  limit?: number
  // When true, returns the full content of each note rather than a
  // preview. Default false to keep response sizes tight.
  includeFullContent?: boolean
}

const MAX_LIMIT = 25
const PREVIEW_CHARS = 240

export async function cyggieGetNotes(args: CyggieGetNotesArgs): Promise<ToolResult> {
  const { db, userId } = args
  const limit = Math.min(args.limit ?? 10, MAX_LIMIT)
  const includeFullContent = args.includeFullContent === true

  if (!args.companyId && !args.contactId && !args.meetingId && !args.query) {
    return err(
      ERROR_CODE.INVALID_INPUT,
      'Pass at least one of companyId, contactId, meetingId, or query.',
    )
  }

  const whereParts = [eq(schema.notes.userId, userId)]
  if (args.companyId) whereParts.push(eq(schema.notes.companyId, args.companyId))
  if (args.contactId) whereParts.push(eq(schema.notes.contactId, args.contactId))
  if (args.meetingId)
    whereParts.push(eq(schema.notes.sourceMeetingId, args.meetingId))
  if (args.query) {
    const q = args.query.trim()
    if (q) {
      whereParts.push(
        sql`to_tsvector('english', coalesce(${schema.notes.title}, '') || ' ' || substring(${schema.notes.content} from 1 for 500000)) @@ plainto_tsquery('english', ${q})`,
      )
    }
  }

  const rows = await db
    .select({
      id: schema.notes.id,
      title: schema.notes.title,
      content: schema.notes.content,
      isPinned: schema.notes.isPinned,
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
    .where(and(...whereParts))
    // Pinned first, then most-recent.
    .orderBy(desc(schema.notes.isPinned), desc(schema.notes.updatedAt))
    .limit(limit)

  if (rows.length === 0) {
    return ok('No notes match the given filters.')
  }

  const header = buildHeader(args, rows.length)
  const items = rows.map((n) => renderNote(n, includeFullContent))
  return ok(`${header}\n\n${items.join('\n\n')}`)
}

function buildHeader(args: CyggieGetNotesArgs, count: number): string {
  const filters: string[] = []
  if (args.companyId) filters.push(`company ${args.companyId}`)
  if (args.contactId) filters.push(`contact ${args.contactId}`)
  if (args.meetingId) filters.push(`meeting ${args.meetingId}`)
  if (args.query) filters.push(`matching "${args.query}"`)
  const filterStr = filters.length > 0 ? ` (${filters.join(', ')})` : ''
  return `## ${count} note${count === 1 ? '' : 's'}${filterStr}`
}

interface NoteRow {
  id: string
  title: string | null
  content: string
  isPinned: boolean
  companyName: string | null
  contactName: string | null
  updatedAt: Date
}

function renderNote(n: NoteRow, includeFullContent: boolean): string {
  const title = n.title ?? '(untitled note)'
  const pin = n.isPinned ? '📌 ' : ''
  const attached = [n.companyName, n.contactName].filter(Boolean).join(' / ')
  const rel = formatRecency(n.updatedAt)
  const date = formatDate(n.updatedAt)
  const dateBit = date && rel ? `${date} (${rel})` : (date ?? rel ?? '')
  const tail = [attached, dateBit].filter(Boolean).join(' · ')

  const body = includeFullContent
    ? n.content
    : preview(n.content)

  const lines: string[] = [`### ${pin}${title}`]
  if (tail) lines.push(`_${tail}_`)
  if (body) lines.push(body)
  lines.push(`[View in Cyggie](${cyggieUrl('note', n.id)})`)
  return lines.join('\n\n')
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_CHARS) return flat
  return flat.slice(0, PREVIEW_CHARS - 1) + '…'
}
