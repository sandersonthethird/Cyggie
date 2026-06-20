// `/cyggie search <q>` handler (External Agents V1 slice 2).
//
// Calls into the existing search SQL (api-gateway/src/mcp/tools/search.ts
// → runCyggieSearch) and renders results as Slack mrkdwn — NOT the
// LLM-friendly markdown the MCP cyggie_search tool returns. Slack's
// mrkdwn flavor is incompatible with standard markdown enough that
// directly forwarding the MCP output would render as literal
// `**bold**` and `[text](url)` strings.

import { cyggieUrl, formatDate, formatRecency } from '../../mcp/format'
import {
  runCyggieSearch,
  type CompanyHit,
  type ContactHit,
  type MeetingHit,
  type NoteHit,
  type SearchResults,
} from '../../mcp/tools/search'
import type { getDb } from '../../db'
import { resolveFirmId } from '../../shared/resolve-firm'
import { bold, bullet, escapeMrkdwn, link } from '../format-mrkdwn'

export interface HandleSlackSearchArgs {
  db: ReturnType<typeof getDb>
  userId: string
  query: string
}

export async function handleSlackSearch(
  args: HandleSlackSearchArgs,
): Promise<string> {
  const { db, userId, query } = args
  const trimmed = query.trim()
  if (!trimmed) {
    return `Usage: ${bold('/cyggie search <name or email>')}\n\nTry ${bold('/cyggie search Acme')} or ${bold('/cyggie search jane@example.com')}.`
  }
  // Firm scope so firm-shared (tagged, non-private) teammate notes surface in
  // the results; null = firmless user (owner-only). This output renders to a
  // human in Slack — not an LLM — so no injection fence is needed here.
  const firmId = await resolveFirmId(db, userId)
  const results = await runCyggieSearch({ db, userId, firmId, query: trimmed, limit: 5 })
  return formatSearchAsMrkdwn(results)
}

export function formatSearchAsMrkdwn(results: SearchResults): string {
  const { query, companies, contacts, meetings, notes } = results
  const totalHits =
    companies.total + contacts.total + meetings.total + notes.total

  if (totalHits === 0) {
    return `No matches for ${bold(`"${query}"`)}.`
  }

  const sections: string[] = [`${bold(`Search results for "${query}"`)}`]

  if (companies.items.length > 0) {
    sections.push(
      sectionHeader('Companies', companies.items.length, companies.total) +
        '\n' +
        companies.items.map(renderCompany).join('\n'),
    )
  }
  if (contacts.items.length > 0) {
    sections.push(
      sectionHeader('Contacts', contacts.items.length, contacts.total) +
        '\n' +
        contacts.items.map(renderContact).join('\n'),
    )
  }
  if (meetings.items.length > 0) {
    sections.push(
      sectionHeader('Meetings', meetings.items.length, meetings.total) +
        '\n' +
        meetings.items.map(renderMeeting).join('\n'),
    )
  }
  if (notes.items.length > 0) {
    sections.push(
      sectionHeader('Notes', notes.items.length, notes.total) +
        '\n' +
        notes.items.map(renderNote).join('\n'),
    )
  }

  return sections.join('\n\n')
}

function sectionHeader(label: string, shown: number, total: number): string {
  const counter = total > shown ? `${shown} of ${total}` : `${shown}`
  return bold(`${label} (${counter})`)
}

function renderCompany(c: CompanyHit): string {
  const meta = [c.industry, c.pipelineStage].filter(Boolean).join(' · ')
  const domain = c.primaryDomain ? ` (${escapeMrkdwn(c.primaryDomain)})` : ''
  const tail = meta ? ` — ${escapeMrkdwn(meta)}` : ''
  return bullet(`${link(cyggieUrl('company', c.id), c.name)}${domain}${tail}`)
}

function renderContact(c: ContactHit): string {
  const at = c.primaryCompanyName
    ? ` @ ${escapeMrkdwn(c.primaryCompanyName)}`
    : ''
  const meta = [c.title, c.email].filter(Boolean).join(' · ')
  const tail = meta ? ` — ${escapeMrkdwn(meta)}` : ''
  return bullet(`${link(cyggieUrl('contact', c.id), c.fullName)}${at}${tail}`)
}

function renderMeeting(m: MeetingHit): string {
  const d = formatDate(m.date)
  const rel = formatRecency(m.date)
  const dateBit = d && rel ? `${d} (${rel})` : (d ?? rel ?? '')
  const tail = dateBit ? ` — ${escapeMrkdwn(dateBit)}` : ''
  return bullet(`${link(cyggieUrl('meeting', m.id), m.title)}${tail}`)
}

function renderNote(n: NoteHit): string {
  const title = n.title ?? '(untitled note)'
  const byline = n.authorName ? `by ${n.authorName}` : null
  const attached = [n.companyName, n.contactName].filter(Boolean).join(' / ')
  const rel = formatRecency(n.updatedAt)
  const tail = [attached, byline, rel].filter(Boolean).join(' · ')
  const tailStr = tail ? ` — ${escapeMrkdwn(tail)}` : ''
  // Notes get a second line with a preview, indented under the bullet.
  return (
    bullet(`${link(cyggieUrl('note', n.id), title)}${tailStr}`) +
    `\n   _${escapeMrkdwn(n.contentPreview)}_`
  )
}
