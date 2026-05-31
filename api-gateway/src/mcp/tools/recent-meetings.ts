// cyggie_recent_meetings — list recent meetings, optionally filtered
// by company or contact.

import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import { cyggieUrl, formatDate, formatRecency } from '../format'

export interface CyggieRecentMeetingsArgs {
  db: ReturnType<typeof getDb>
  userId: string
  // At most ONE of companyId/contactId may be set. If both are set, the
  // tool returns INVALID_INPUT — LLM should issue a separate call per
  // entity since the result shape differs (meeting belonged to company X
  // vs participated in by contact Y are different filters).
  companyId?: string
  contactId?: string
  // ISO date or Date for "meetings after". Defaults to no lower bound.
  since?: Date | string
  // Default 5, max 20.
  limit?: number
}

const MAX_LIMIT = 20

export async function cyggieRecentMeetings(
  args: CyggieRecentMeetingsArgs,
): Promise<ToolResult> {
  const { db, userId, companyId, contactId } = args
  const limit = Math.min(args.limit ?? 5, MAX_LIMIT)

  if (companyId && contactId) {
    return err(
      ERROR_CODE.INVALID_INPUT,
      'Pass at most one of companyId or contactId; not both.',
    )
  }

  // Normalize `since` to a Date (or undefined).
  let since: Date | undefined
  if (args.since) {
    since = typeof args.since === 'string' ? new Date(args.since) : args.since
    if (Number.isNaN(since.getTime())) {
      return err(
        ERROR_CODE.INVALID_INPUT,
        `Invalid 'since' value: "${String(args.since)}". Pass an ISO date string or Date.`,
      )
    }
  }

  // Resolve which meeting ids to consider, based on filter.
  let meetingIds: string[] | null = null
  if (companyId) {
    const linkRows = await db
      .select({ meetingId: schema.meetingCompanyLinks.meetingId })
      .from(schema.meetingCompanyLinks)
      .where(eq(schema.meetingCompanyLinks.companyId, companyId))
    meetingIds = linkRows.map((r) => r.meetingId)
    if (meetingIds.length === 0) {
      return ok(`No meetings found for the given company.`)
    }
  } else if (contactId) {
    const linkRows = await db
      .select({ meetingId: schema.meetingSpeakerContactLinks.meetingId })
      .from(schema.meetingSpeakerContactLinks)
      .where(eq(schema.meetingSpeakerContactLinks.contactId, contactId))
    meetingIds = linkRows.map((r) => r.meetingId)
    if (meetingIds.length === 0) {
      return ok(`No meetings found for the given contact.`)
    }
  }

  // Build the where clause. user_id always; meeting id list when filtered;
  // date >= since when set.
  const whereParts = [eq(schema.meetings.userId, userId)]
  if (meetingIds !== null) {
    whereParts.push(inArray(schema.meetings.id, meetingIds))
  }
  if (since) {
    whereParts.push(gte(schema.meetings.date, since))
  }

  const rows = await db
    .select({
      id: schema.meetings.id,
      title: schema.meetings.title,
      date: schema.meetings.date,
      durationSeconds: schema.meetings.durationSeconds,
      summary: schema.meetings.summary,
    })
    .from(schema.meetings)
    .where(and(...whereParts))
    .orderBy(desc(schema.meetings.date))
    .limit(limit)

  if (rows.length === 0) {
    return ok(`No meetings match the given filters.`)
  }

  const header = buildHeader({ companyId, contactId, since, count: rows.length })
  const items = rows.map((m) => renderMeetingRow(m))

  return ok(`${header}\n\n${items.join('\n\n')}`)
}

function buildHeader(args: {
  companyId?: string
  contactId?: string
  since?: Date
  count: number
}): string {
  const filters: string[] = []
  if (args.companyId) filters.push(`company ${args.companyId}`)
  if (args.contactId) filters.push(`contact ${args.contactId}`)
  if (args.since) filters.push(`since ${formatDate(args.since)}`)
  const filterStr = filters.length > 0 ? ` (filtered: ${filters.join(', ')})` : ''
  return `## ${args.count} recent meeting${args.count === 1 ? '' : 's'}${filterStr}`
}

interface MeetingRow {
  id: string
  title: string | null
  date: Date
  durationSeconds: number | null
  summary: string | null
}

function renderMeetingRow(m: MeetingRow): string {
  const title = m.title ?? '(untitled)'
  const date = formatDate(m.date)
  const rel = formatRecency(m.date)
  const dur =
    m.durationSeconds !== null
      ? ` · ${Math.round(m.durationSeconds / 60)}min`
      : ''
  const dateBit = date && rel ? `${date} (${rel})` : (date ?? rel ?? '')

  const lines: string[] = [
    `### ${title}`,
    `${dateBit}${dur} — [${cyggieUrl('meeting', m.id)}]`,
  ]
  if (m.summary && m.summary.trim()) {
    // Keep summary tight; full transcript via cyggie_get_meeting.
    const truncated =
      m.summary.length > 400
        ? m.summary.slice(0, 397) + '…'
        : m.summary
    lines.push(truncated)
  }
  return lines.join('\n')
}
