// cyggie_get_contact — fuzzy-resolve a contact (by name, email, or id)
// then return a detailed markdown block with title, company, recent
// activity, and key takeaways.

import { and, eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../../db'
import { err, ok, ERROR_CODE, type ToolResult } from '../../shared/error-envelope'
import {
  cyggieUrl,
  formatDate,
  formatRecency,
  formatUSD,
  labeledLines,
} from '../format'
import { resolveContact, type ContactCandidate } from '../resolvers'

export interface CyggieGetContactArgs {
  db: ReturnType<typeof getDb>
  userId: string
  // Free-form: name, email, or cuid2 id.
  query: string
}

export async function cyggieGetContact(args: CyggieGetContactArgs): Promise<ToolResult> {
  const { db, userId, query } = args
  const resolved = await resolveContact({ db, userId, query })

  if (resolved.kind === 'none') {
    return err(
      ERROR_CODE.NOT_FOUND,
      `No contact matches "${query}". Try the contact's email or use cyggie_search.`,
    )
  }

  if (resolved.kind === 'candidates') {
    return err(
      ERROR_CODE.AMBIGUOUS,
      `Multiple contacts match "${query}". Disambiguate by email or id.`,
      { candidates: resolved.contacts.map(toCandidateDetail) },
    )
  }

  // Single match — load the full row + (optional) primary company name.
  const id = resolved.contact.id
  const fullRows = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, userId), eq(schema.contacts.id, id)))
    .limit(1)
  const c = fullRows[0]
  if (!c) {
    return err(ERROR_CODE.NOT_FOUND, `Contact "${query}" was just deleted.`)
  }

  let primaryCompanyName: string | null = null
  if (c.primaryCompanyId) {
    const compRows = await db
      .select({ name: schema.orgCompanies.canonicalName })
      .from(schema.orgCompanies)
      .where(eq(schema.orgCompanies.id, c.primaryCompanyId))
      .limit(1)
    primaryCompanyName = compRows[0]?.name ?? null
  }

  // Live last-touch (the denorm last_meeting_at/last_email_at columns were
  // dropped): most recent of speaker-tagged + calendar-attendee-email meetings.
  const ltRes = await db.execute(sql`
    SELECT max(last_at) AS last_at FROM (
      SELECT max(m.date) AS last_at
      FROM meeting_speaker_contact_links mscl
      JOIN meetings m ON m.id = mscl.meeting_id
      WHERE m.user_id = ${userId} AND mscl.contact_id = ${id}
      UNION ALL
      SELECT max(m.date) AS last_at
      FROM meetings m
      CROSS JOIN LATERAL jsonb_array_elements_text(m.attendee_emails) AS ae(email)
      JOIN contact_emails ce ON lower(ce.email) = lower(ae.email)
      WHERE m.user_id = ${userId} AND ce.contact_id = ${id}
    ) s
  `)
  const ltRaw = (ltRes.rows[0] as { last_at: Date | string | null } | undefined)?.last_at ?? null
  const lastTouchAt = ltRaw ? new Date(ltRaw) : null

  return ok(
    renderContactMarkdown(c, primaryCompanyName, lastTouchAt),
    cyggieUrl('contact', c.id),
  )
}

function toCandidateDetail(c: ContactCandidate): {
  id: string
  fullName: string
  title: string | null
  email: string | null
  lastTouched: string | null
} {
  return {
    id: c.id,
    fullName: c.fullName,
    title: c.title,
    email: c.email,
    lastTouched: formatRecency(c.lastTouchedAt),
  }
}

function renderContactMarkdown(
  c: typeof schema.contacts.$inferSelect,
  primaryCompanyName: string | null,
  lastTouchAt: Date | null,
): string {
  const sections: string[] = []

  // Header
  sections.push(`# ${c.fullName}`)

  // Top metadata block
  const meta = labeledLines([
    ['Title', c.title],
    ['Company', primaryCompanyName],
    ['Email', c.email],
    ['Phone', c.phone],
    ['LinkedIn', c.linkedinUrl],
    ['Type', c.contactType],
    ['HQ', joinLoc(c.city, c.state, c.country)],
  ])
  if (meta) sections.push(meta)

  // Investor-specific block — only render if this is an investor and
  // has investor metadata. Saves noise for non-investor contacts.
  if (c.contactType === 'investor') {
    const investorLines = labeledLines([
      ['Fund size', formatUSD(c.fundSize)],
      [
        'Typical check',
        formatCheckRange(c.typicalCheckSizeMin, c.typicalCheckSizeMax),
      ],
      ['Target investment stage', formatJsonArray(c.investmentStageFocus)],
      ['Target investment sector', formatJsonArray(c.investmentSectorFocus)],
    ])
    if (investorLines) {
      sections.push(`## Investor profile\n${investorLines}`)
    }
  }

  // Activity
  const activityLines = labeledLines([
    ['Last touch', formatActivityDate(lastTouchAt)],
    ['Relationship', c.relationshipStrength],
  ])
  if (activityLines) {
    sections.push(`## Activity\n${activityLines}`)
  }

  // AI key takeaways — same pattern as company
  if (c.keyTakeawaysUserNote || c.keyTakeaways) {
    const parts: string[] = ['## Key takeaways']
    if (c.keyTakeawaysUserNote) {
      parts.push(`**User note:** ${c.keyTakeawaysUserNote}`)
    }
    if (c.keyTakeaways) {
      parts.push(c.keyTakeaways)
    }
    sections.push(parts.join('\n\n'))
  }

  // Footer
  sections.push(`---\n[View in Cyggie](${cyggieUrl('contact', c.id)})`)

  return sections.join('\n\n')
}

function joinLoc(
  city: string | null,
  state: string | null,
  country: string | null,
): string | null {
  const bits = [city, state, country].filter((b): b is string => !!b)
  return bits.length > 0 ? bits.join(', ') : null
}

function formatActivityDate(d: Date | null): string | null {
  if (!d) return null
  const date = formatDate(d)
  const rel = formatRecency(d)
  if (date && rel) return `${date} (${rel})`
  return date ?? rel ?? null
}

function formatCheckRange(
  min: number | null,
  max: number | null,
): string | null {
  const minStr = formatUSD(min)
  const maxStr = formatUSD(max)
  if (minStr && maxStr) return `${minStr}–${maxStr}`
  return minStr ?? maxStr ?? null
}

function formatJsonArray(v: unknown): string | null {
  if (!Array.isArray(v)) return null
  const strs = v.filter((x): x is string => typeof x === 'string')
  if (strs.length === 0) return null
  return strs.join(', ')
}
