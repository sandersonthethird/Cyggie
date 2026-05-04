/**
 * Pure formatters that turn repo rows into the markdown sections that all chat
 * paths assemble into LLM context. Each chat builder (company / contact /
 * meeting / search-results / global) calls these helpers so the wire format
 * stays consistent across surfaces.
 *
 *   ┌──────────────────────────┐
 *   │ entity context-builder    │ picks WHICH rows to fetch (per-kind)
 *   └────────────┬─────────────┘
 *                │ rows
 *                ▼
 *   ┌──────────────────────────┐
 *   │  context-formatters.ts    │ HOW each section is rendered
 *   │   formatMeetingsSection   │  (this file — pure, no DB)
 *   │   formatEmailsSection     │
 *   │   formatNotesSection      │
 *   │   formatFlaggedFilesSection│
 *   └────────────┬─────────────┘
 *                │ markdown
 *                ▼
 *           runChatTurn(...)
 *
 * Wire-format invariant: each formatter returns its full section markdown
 * INCLUDING the `## Header` line, with NO leading or trailing blank lines.
 * Callers assemble multiple sections by joining with '\n\n' (one blank line
 * between sections) — this matches the existing `parts.push('')` +
 * `parts.join('\n')` pattern in company-chat.ts / contact-context-builder.ts.
 *
 * Empty inputs → '' (so callers can compose with `.filter(Boolean)`).
 */

import { readSummary, readTranscript, readLocalFile } from '../storage/file-manager'
import { basename } from 'path'

export interface SectionCaps {
  /** Per-item char cap (truncate-with-ellipsis above this). */
  perItem: number
  /** Total chars across all items in the section (stops adding once reached). */
  total: number
  /** Max items considered before applying body filters. Default: unlimited. */
  maxItems?: number
}

// ── Meeting helpers ────────────────────────────────────────────────────

export interface MeetingRef {
  id: string
  title: string
  date: string
}

export interface MeetingFull {
  id: string
  summaryPath?: string | null
  transcriptPath?: string | null
}

/**
 * Renders meeting summaries with transcript fallback for meetings without one.
 * The "summaries first / transcripts only when no summary" pattern was
 * duplicated across company-chat / contact-context-builder / chat.ts — this
 * is the shared implementation.
 *
 * Output:
 *   ## Meeting Summaries
 *   ### Title (M/D/YYYY)
 *   {summary excerpt}
 *
 *   ### Title2 (M/D/YYYY)
 *   {summary2 excerpt}
 *
 *   ## Meeting Transcripts
 *   ### Title3 (M/D/YYYY)
 *   {transcript3 excerpt}
 *
 * Returns '' if nothing renders. Subsections separated by one blank line
 * (one '\n\n'); items within a subsection also separated by one blank line.
 */
export function formatMeetingsSection(opts: {
  meetings: MeetingRef[]
  loadFull: (id: string) => MeetingFull | null
  summaryCaps: SectionCaps
  transcriptCaps: SectionCaps
}): string {
  const { meetings, loadFull, summaryCaps, transcriptCaps } = opts
  const summariesAdded = new Set<string>()

  // Pass 1: summaries
  let summaryTotal = 0
  const summaryParts: string[] = []
  for (const m of meetings) {
    if (summaryTotal >= summaryCaps.total) break
    const full = loadFull(m.id)
    if (!full?.summaryPath) continue
    const content = readSummary(full.summaryPath)
    if (!content) continue
    const excerpt = content.length > summaryCaps.perItem
      ? content.substring(0, summaryCaps.perItem) + '...'
      : content
    summaryParts.push(`### ${m.title} (${formatDate(m.date)})\n${excerpt}`)
    summaryTotal += excerpt.length
    summariesAdded.add(m.id)
  }

  // Pass 2: transcripts (only for meetings without summaries)
  let transcriptTotal = 0
  const transcriptParts: string[] = []
  for (const m of meetings) {
    if (transcriptTotal >= transcriptCaps.total) break
    if (summariesAdded.has(m.id)) continue
    const full = loadFull(m.id)
    if (!full?.transcriptPath) continue
    const content = readTranscript(full.transcriptPath)
    if (!content) continue
    const excerpt = content.length > transcriptCaps.perItem
      ? content.substring(0, transcriptCaps.perItem) + '...'
      : content
    transcriptParts.push(`### ${m.title} (${formatDate(m.date)})\n${excerpt}`)
    transcriptTotal += excerpt.length
  }

  const blocks: string[] = []
  if (summaryParts.length > 0) {
    blocks.push('## Meeting Summaries\n' + summaryParts.join('\n\n'))
  }
  if (transcriptParts.length > 0) {
    blocks.push('## Meeting Transcripts\n' + transcriptParts.join('\n\n'))
  }
  return blocks.join('\n\n')
}

// ── Email helpers ──────────────────────────────────────────────────────

export interface EmailRef {
  fromEmail: string
  subject: string | null
  receivedAt?: string | null
  sentAt?: string | null
  bodyText?: string | null
}

const MIN_EMAIL_BODY_CHARS = 50

/**
 * Renders email correspondence as `From / Subject / Date / body` blocks
 * separated by `---`. Skips bodies under MIN_EMAIL_BODY_CHARS (likely auto-
 * replies, calendar invites). Date prefers receivedAt over sentAt; falls
 * back to '' if neither is present.
 */
export function formatEmailsSection(emails: EmailRef[], caps: SectionCaps): string {
  const limit = caps.maxItems ?? emails.length
  const trimmed = emails.slice(0, limit)
  const parts: string[] = []
  let total = 0
  for (const e of trimmed) {
    if (!e.bodyText || e.bodyText.trim().length < MIN_EMAIL_BODY_CHARS) continue
    if (total >= caps.total) break
    const body = e.bodyText.length > caps.perItem
      ? e.bodyText.substring(0, caps.perItem) + '...'
      : e.bodyText
    const date = e.receivedAt || e.sentAt || ''
    parts.push(`From: ${e.fromEmail}\nSubject: ${e.subject || '(no subject)'}\nDate: ${date}\n\n${body}`)
    total += body.length
  }
  if (parts.length === 0) return ''
  return '## Email Correspondence\n' + parts.join('\n\n---\n\n')
}

// ── Notes helpers ──────────────────────────────────────────────────────

export interface NoteRef {
  /** Optional title (rendered as `**title**` if present). */
  title?: string | null
  content: string
  /** ISO timestamp; rendered as `(M/D/YYYY)` prefix. */
  createdAt?: string | null
}

const MIN_NOTE_CONTENT_CHARS = 10

/**
 * Renders notes (company or contact) with date prefix and optional title.
 * Skips empty / placeholder notes. Matches the existing
 * contact-context-builder.ts wire format: `(date) {content}`.
 */
export function formatNotesSection(notes: NoteRef[], caps: SectionCaps): string {
  const parts: string[] = []
  let total = 0
  for (const n of notes) {
    if (!n.content || n.content.trim().length < MIN_NOTE_CONTENT_CHARS) continue
    if (total >= caps.total) break
    const excerpt = n.content.length > caps.perItem
      ? n.content.substring(0, caps.perItem) + '...'
      : n.content
    const date = n.createdAt ? formatDate(n.createdAt) : ''
    const titleLine = n.title ? `**${n.title}**\n` : ''
    parts.push(`${date ? `(${date}) ` : ''}${titleLine}${excerpt}`)
    total += excerpt.length
  }
  if (parts.length === 0) return ''
  return '## Notes\n' + parts.join('\n\n')
}

// ── Flagged-files helpers ──────────────────────────────────────────────

const MIN_FLAGGED_FILE_CHARS = 50

/**
 * Renders user-flagged files (the curated subset of files attached to an
 * entity). `readLocalFile` is async because PDFs / spreadsheets may need
 * parsing. Files that fail to read or are below MIN_FLAGGED_FILE_CHARS are
 * silently skipped — they don't count toward the cap.
 */
export async function formatFlaggedFilesSection(
  fileIds: string[],
  caps: SectionCaps
): Promise<string> {
  const parts: string[] = []
  let total = 0
  for (const id of fileIds) {
    if (total >= caps.total) break
    const content = await readLocalFile(id)
    if (!content || content.trim().length < MIN_FLAGGED_FILE_CHARS) continue
    const excerpt = content.length > caps.perItem
      ? content.substring(0, caps.perItem) + '...'
      : content
    parts.push(`### ${basename(id)}\n${excerpt}`)
    total += excerpt.length
  }
  if (parts.length === 0) return ''
  return '## Linked Documents\n' + parts.join('\n\n')
}

// ── util ───────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}
