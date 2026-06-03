// cyggie_get_meeting — fetch one meeting by id, return notes + summary +
// transcript snippet, plus linked company/contact metadata.

import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import { cyggieUrl, formatDate, formatRecency } from '../format'
import { flattenSegments, truncateTranscript } from '../../llm/transcript-flatten'

export interface CyggieGetMeetingArgs {
  db: ReturnType<typeof getDb>
  userId: string
  id: string
  // Defaults to true. When false, the transcript section is omitted —
  // useful for LLM agents that want a quick overview without paying
  // tokens for the full transcript.
  includeTranscript?: boolean
}

export async function cyggieGetMeeting(
  args: CyggieGetMeetingArgs,
): Promise<ToolResult> {
  const { db, userId, id } = args
  const includeTranscript = args.includeTranscript !== false

  const rows = await db
    .select()
    .from(schema.meetings)
    .where(and(eq(schema.meetings.userId, userId), eq(schema.meetings.id, id)))
    .limit(1)
  const m = rows[0]
  if (!m) {
    return err(ERROR_CODE.NOT_FOUND, `No meeting with id "${id}".`)
  }

  // Linked companies + speaker contacts — one batched lookup each.
  const [companyLinks, contactLinks] = await Promise.all([
    db
      .select({
        companyName: schema.orgCompanies.canonicalName,
        companyId: schema.orgCompanies.id,
      })
      .from(schema.meetingCompanyLinks)
      .innerJoin(
        schema.orgCompanies,
        eq(schema.meetingCompanyLinks.companyId, schema.orgCompanies.id),
      )
      .where(eq(schema.meetingCompanyLinks.meetingId, id)),
    db
      .select({
        contactName: schema.contacts.fullName,
        contactId: schema.contacts.id,
      })
      .from(schema.meetingSpeakerContactLinks)
      .innerJoin(
        schema.contacts,
        eq(schema.meetingSpeakerContactLinks.contactId, schema.contacts.id),
      )
      .where(eq(schema.meetingSpeakerContactLinks.meetingId, id)),
  ])

  return ok(
    renderMeetingMarkdown(m, companyLinks, contactLinks, includeTranscript),
    cyggieUrl('meeting', m.id),
  )
}

function renderMeetingMarkdown(
  m: typeof schema.meetings.$inferSelect,
  companies: Array<{ companyName: string; companyId: string }>,
  contacts: Array<{ contactName: string; contactId: string }>,
  includeTranscript: boolean,
): string {
  const sections: string[] = []

  // Header
  const title = m.title ?? '(untitled meeting)'
  sections.push(`# ${title}`)

  // Top metadata
  const date = formatDate(m.date)
  const rel = formatRecency(m.date)
  const dateLine = date && rel ? `${date} (${rel})` : (date ?? rel ?? '')
  const dur =
    m.durationSeconds !== null
      ? `${Math.round(m.durationSeconds / 60)} minutes`
      : null
  const platform = m.meetingPlatform
  const metaLines = [
    dateLine ? `**Date:** ${dateLine}` : null,
    dur ? `**Duration:** ${dur}` : null,
    platform ? `**Platform:** ${platform}` : null,
  ].filter(Boolean)
  if (metaLines.length > 0) sections.push(metaLines.join(' · '))

  // Companies + speaker contacts
  if (companies.length > 0) {
    sections.push(
      `**Companies:** ${companies
        .map((c) => `[${c.companyName}](${cyggieUrl('company', c.companyId)})`)
        .join(', ')}`,
    )
  }
  if (contacts.length > 0) {
    sections.push(
      `**Speakers:** ${contacts
        .map((c) => `[${c.contactName}](${cyggieUrl('contact', c.contactId)})`)
        .join(', ')}`,
    )
  }

  if (m.notes && m.notes.trim()) {
    sections.push(`## Notes\n${m.notes}`)
  }

  if (m.summary && m.summary.trim()) {
    sections.push(`## Summary\n${m.summary}`)
  }

  if (includeTranscript) {
    const transcript = flattenSegments(m.transcriptSegments)
    if (transcript.length > 0) {
      sections.push(`## Transcript\n${truncateTranscript(transcript)}`)
    }
  }

  // Footer
  sections.push(`---\n[View in Cyggie](${cyggieUrl('meeting', m.id)})`)

  return sections.join('\n\n')
}
