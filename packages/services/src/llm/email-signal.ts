/**
 * Pure, deterministic email-signal heuristics shared by every chat context
 * builder (desktop-local `formatEmailsSection` and the gateway
 * `buildContextForSession` email block). No DB, no LLM, no I/O — it operates on
 * an in-memory row shape so both the SQLite (desktop) and Postgres (gateway)
 * retrieval paths can score identically.
 *
 * Two jobs:
 *   - `isLowSignalEmail` — hard-drop obvious noise (calendar invites, promo /
 *     update / forum blasts, near-empty bodies, one-way intros with no reply).
 *   - `scoreEmailSignal` — rank the survivors so a capped context budget is
 *     spent on the highest-signal threads (real two-way correspondence,
 *     manually-linked, longer threads), not merely the most recent.
 *
 * "Heuristics only" by design — no LLM classification. The shape is forward
 * compatible: an AI signal/summary field can be added to EmailSignalInput later
 * without touching call sites.
 */

/** Bodies shorter than this are treated as noise (auto-replies, invites). */
export const MIN_EMAIL_BODY_CHARS = 50

/** Gmail category labels that mark machine / bulk mail rather than real 1:1 correspondence. */
const NOISE_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'CATEGORY_SOCIAL',
])

/** Subject prefixes Gmail/Outlook attach to calendar-invite traffic. */
const CALENDAR_SUBJECT_PREFIXES = [
  'invitation:',
  'accepted:',
  'declined:',
  'tentative:',
  'canceled:',
  'cancelled:',
  'updated invitation:',
  'new time proposed:',
]

export interface EmailSignalInput {
  bodyText?: string | null
  subject?: string | null
  /** Number of messages in the thread this row represents. */
  threadMessageCount?: number | null
  /** Raw Gmail labels JSON array (string), e.g. '["INBOX","CATEGORY_PROMOTIONS"]'. */
  labelsJson?: string | null
  hasAttachments?: boolean | null
  /** Link confidence from email_{company,contact}_links (0..1). */
  linkConfidence?: number | null
  linkedBy?: string | null
  /** Thread contains both an inbound and an outbound message (real back-and-forth). */
  isTwoWay?: boolean | null
}

function parseLabels(labelsJson: string | null | undefined): string[] {
  if (!labelsJson) return []
  try {
    const parsed = JSON.parse(labelsJson)
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : []
  } catch {
    return []
  }
}

function hasNoiseLabel(labelsJson: string | null | undefined): boolean {
  return parseLabels(labelsJson).some((l) => NOISE_LABELS.has(l.toUpperCase()))
}

function isCalendarInvite(e: EmailSignalInput): boolean {
  const subject = (e.subject ?? '').trim().toLowerCase()
  if (CALENDAR_SUBJECT_PREFIXES.some((p) => subject.startsWith(p))) return true
  return false
}

/**
 * Hard filter: emails that are almost never useful correspondence. Returns true
 * for things we should drop before they consume any context budget.
 */
export function isLowSignalEmail(e: EmailSignalInput): boolean {
  const body = (e.bodyText ?? '').trim()
  if (body.length < MIN_EMAIL_BODY_CHARS) return true
  if (isCalendarInvite(e)) return true
  if (hasNoiseLabel(e.labelsJson)) return true
  // One-way blast/intro: a lone message with no reply and no outbound side.
  // Exception: a manually-tagged email is the user's explicit signal — never
  // drop it as "one-way" (linkedBy is otherwise only consulted in
  // scoreEmailSignal, which never runs for dropped threads).
  const count = e.threadMessageCount ?? 1
  const isManual = (e.linkedBy ?? '').toLowerCase() === 'manual'
  if (count <= 1 && e.isTwoWay !== true && !isManual) return true
  return false
}

/**
 * Relative signal score for ranking survivors of `isLowSignalEmail`. Higher =
 * more likely to be substantive correspondence. Caller still applies recency as
 * the final tiebreak (this score is recency-agnostic on purpose so the two can
 * be combined explicitly).
 */
export function scoreEmailSignal(e: EmailSignalInput): number {
  let score = 0
  // Real back-and-forth is the strongest signal.
  if (e.isTwoWay === true) score += 5
  // Longer threads tend to be active relationships (capped contribution).
  const count = e.threadMessageCount ?? 1
  score += Math.min(count, 6)
  // A human explicitly tied this email to the entity.
  if ((e.linkedBy ?? '').toLowerCase() === 'manual') score += 4
  // High auto-link confidence beats low.
  if (typeof e.linkConfidence === 'number') score += e.linkConfidence * 2
  // Reward substantive bodies (1 pt per ~500 chars, capped).
  const bodyLen = (e.bodyText ?? '').trim().length
  score += Math.min(bodyLen / 500, 4)
  return score
}

// =============================================================================
// Caps — single source of truth (decision 1A). Both desktop formatter and the
// gateway builder import these instead of defining their own.
// `maxItems` is the per-company thread count and the default for the Part E
// `emailThreadsPerCompany` user preference; `perItem` is the per-THREAD char cap
// (Part F renders a reconstructed thread, not a single message).
// =============================================================================
export interface EmailCaps {
  perItem: number
  total: number
  maxItems: number
}

export const COMPANY_EMAIL_CAPS: EmailCaps = { perItem: 10_000, total: 30_000, maxItems: 20 }
export const CONTACT_EMAIL_CAPS: EmailCaps = { perItem: 8_000, total: 24_000, maxItems: 20 }

// ── Part E: per-company cap preference ──────────────────────────────────────
export const EMAIL_THREADS_PREF_KEY = 'emailThreadsPerCompany'
const EMAIL_CAP_MIN = 1
const EMAIL_CAP_MAX = 100

/**
 * Resolve the per-company email-thread cap from a stored preference value
 * (string|null from SQLite/Neon user_preferences). Falls back to the default
 * and clamps to [EMAIL_CAP_MIN, EMAIL_CAP_MAX]; never throws.
 */
export function resolveEmailCap(
  value: string | number | null | undefined,
  def: number = COMPANY_EMAIL_CAPS.maxItems,
): number {
  const n = typeof value === 'number' ? value : value != null ? parseInt(value, 10) : NaN
  if (!Number.isFinite(n)) return def
  return Math.max(EMAIL_CAP_MIN, Math.min(EMAIL_CAP_MAX, Math.trunc(n)))
}

/**
 * Build the render caps for a resolved per-entity thread `limit`. `maxItems`
 * becomes the limit and `total` scales with it (`perItem × limit`) so the
 * section budget never binds before the thread-count cap does — otherwise a
 * fixed `total` silently throttles the user's `emailThreadsPerCompany` setting
 * to a handful of threads. Single huge threads are still bounded by `perItem`,
 * and the gateway's aggregate SELECTED_COMPANIES_MAX_CHARS backstops multi-
 * company context.
 */
export function emailCapsForLimit(base: EmailCaps, limit: number): EmailCaps {
  const maxItems = Math.max(1, limit)
  return { perItem: base.perItem, maxItems, total: base.perItem * maxItems }
}

// =============================================================================
// truncateEmailBody — keep-both-ends truncation (Part D).
//
// Email quoting is newest-on-top / oldest-at-bottom, and reconstructed threads
// run oldest→newest, so a plain head- or tail-slice always drops content the
// user cares about (the original ask or the latest reply). Instead keep a head
// slice + a tail slice with a marker between. Clamps so output is always
// length ≤ max with no negative slices (decision 3A).
// =============================================================================
const TRUNCATE_MARKER = '\n[...thread history truncated...]\n'
const HEAD_RATIO = 0.65

export function truncateEmailBody(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  // Not enough room for head+marker+tail → plain head slice.
  if (max <= TRUNCATE_MARKER.length + 2) return text.slice(0, max)
  const budget = max - TRUNCATE_MARKER.length
  const head = Math.max(1, Math.floor(budget * HEAD_RATIO))
  const tail = budget - head
  if (tail <= 0) return text.slice(0, max)
  return text.slice(0, head) + TRUNCATE_MARKER + text.slice(text.length - tail)
}

// =============================================================================
// stripQuotedHistory — return a message's NOVEL content by cutting quoted
// history (Part F). Email replies top-post: novel text first, quoted history
// after a delimiter. We cut at the FIRST delimiter line. Conservative: if no
// delimiter is found, or the novel part is empty, return the whole body
// (handles top-posting; bottom-posting/interleaved is the accepted mis-cut
// risk). Pure string work.
// =============================================================================
const ATTRIBUTION_RE = /^\s*on\s.+\bwrote:\s*$/i // "On <date>, <name> wrote:"
const OUTLOOK_ORIGINAL_RE = /^\s*-{2,}\s*original message\s*-{2,}/i
const OUTLOOK_HEADER_RE = /^\s*from:\s.+/i
const OUTLOOK_HEADER_FOLLOW_RE = /^\s*(sent|date|to):\s/i

export function stripQuotedHistory(body: string | null | undefined): string {
  if (!body) return ''
  const lines = body.split('\n')
  const isQuoteLine = (s: string): boolean => s.trimStart().startsWith('>')
  let cut = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // A RUN of ≥2 consecutive '>' lines is a real quoted block; a lone '>'
    // line is likely legitimate content (markdown blockquote, "> 50% MoM",
    // a pasted snippet) — don't cut on it.
    const quotedBlock = isQuoteLine(line) && isQuoteLine(lines[i + 1] ?? '')
    if (
      ATTRIBUTION_RE.test(line) ||
      OUTLOOK_ORIGINAL_RE.test(line) ||
      quotedBlock ||
      (OUTLOOK_HEADER_RE.test(line) && OUTLOOK_HEADER_FOLLOW_RE.test(lines[i + 1] ?? ''))
    ) {
      cut = i
      break
    }
  }
  if (cut === -1) return body.trim()
  const novel = lines.slice(0, cut).join('\n').trim()
  // Entirely-quoted message (forward with no comment) → keep the whole body so
  // we don't drop it; reconstruction tolerates the rare repeat.
  return novel.length > 0 ? novel : body.trim()
}

// =============================================================================
// renderEmailRows — the single shared email renderer (decision 2A + Part F).
//
//   rows (message ⋈ link, any order)
//        │ group by threadGroup
//        ▼
//   threads → summarizeThreadSignal → isLowSignalEmail filter
//        │ rank: scoreEmailSignal desc, recency desc
//        │ cross-block dedup via `seen` (Part C)
//        ▼  top maxItems
//   reconstruct oldest→newest (stripQuotedHistory per msg) → truncateEmailBody
//        ▼
//   "## Email Correspondence" block (or '' if nothing survives)
// =============================================================================
export interface EmailRowForThread {
  threadGroup: string
  messageId: string
  fromName?: string | null
  fromEmail: string
  subject?: string | null
  direction?: string | null
  bodyText?: string | null
  labelsJson?: string | null
  hasAttachments?: boolean | null
  receivedAt?: string | Date | null
  sentAt?: string | Date | null
  linkConfidence?: number | null
  linkedBy?: string | null
}

function timeMs(v: string | Date | null | undefined): number {
  if (!v) return 0
  const d = v instanceof Date ? v : new Date(v)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}

function dateLabel(v: string | Date | null | undefined): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

// Subject/labels/attachments/two-way come from the thread; bodyText is the
// thread's RECONSTRUCTED novel content (not just the latest message) so a
// substantive multi-message thread with a terse latest reply isn't wrongly
// dropped by the body-length check.
function summarizeThreadSignal(msgsAsc: EmailRowForThread[], novelBody: string): EmailSignalInput {
  const latest = msgsAsc[msgsAsc.length - 1]
  return {
    bodyText: novelBody,
    subject: latest?.subject ?? null,
    threadMessageCount: msgsAsc.length,
    labelsJson: latest?.labelsJson ?? null,
    hasAttachments: latest?.hasAttachments ?? false,
    linkConfidence: msgsAsc.reduce((m, r) => Math.max(m, r.linkConfidence ?? 0), 0),
    linkedBy: msgsAsc.some((r) => (r.linkedBy ?? '').toLowerCase() === 'manual') ? 'manual' : 'auto',
    isTwoWay:
      msgsAsc.some((r) => r.direction === 'inbound') &&
      msgsAsc.some((r) => r.direction === 'outbound'),
  }
}

/** Reconstruct the thread's labeled novel content (no truncation). */
function reconstructThread(msgsAsc: EmailRowForThread[]): string {
  const parts: string[] = []
  for (const m of msgsAsc) {
    const novel = stripQuotedHistory(m.bodyText)
    if (!novel) continue
    const who = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail
    const date = dateLabel(m.receivedAt ?? m.sentAt)
    parts.push(`From: ${who}${date ? ` · ${date}` : ''}\n${novel}`)
  }
  return parts.join('\n\n— — —\n\n')
}

export function renderEmailRows(
  rows: EmailRowForThread[],
  caps: EmailCaps,
  seen?: Set<string>,
): string {
  if (rows.length === 0) return ''

  // Group into threads.
  const groups = new Map<string, EmailRowForThread[]>()
  for (const r of rows) {
    const bucket = groups.get(r.threadGroup) ?? []
    bucket.push(r)
    groups.set(r.threadGroup, bucket)
  }

  interface Thread {
    key: string
    subject: string | null
    reconstructed: string // labeled novel content, oldest→newest (untruncated)
    signal: EmailSignalInput
    latestMs: number
  }
  const threads: Thread[] = []
  for (const [key, bucket] of groups) {
    if (seen?.has(key)) continue
    const msgsAsc = [...bucket].sort(
      (a, b) => timeMs(a.receivedAt ?? a.sentAt) - timeMs(b.receivedAt ?? b.sentAt),
    )
    const reconstructed = reconstructThread(msgsAsc)
    const signal = summarizeThreadSignal(msgsAsc, reconstructed)
    if (isLowSignalEmail(signal)) continue
    const latest = msgsAsc[msgsAsc.length - 1]
    threads.push({
      key,
      subject: latest?.subject ?? null,
      reconstructed,
      signal,
      latestMs: timeMs(latest?.receivedAt ?? latest?.sentAt),
    })
  }

  threads.sort((a, b) => {
    const byScore = scoreEmailSignal(b.signal) - scoreEmailSignal(a.signal)
    return byScore !== 0 ? byScore : b.latestMs - a.latestMs
  })

  const blocks: string[] = []
  let total = 0
  for (const t of threads.slice(0, caps.maxItems)) {
    const body = truncateEmailBody(t.reconstructed, caps.perItem)
    if (!body.trim()) continue
    if (total >= caps.total) break
    blocks.push(`Subject: ${t.subject || '(no subject)'}\n${body}`)
    total += body.length
    seen?.add(t.key)
  }
  if (blocks.length === 0) return ''
  return '## Email Correspondence\n' + blocks.join('\n\n---\n\n')
}
