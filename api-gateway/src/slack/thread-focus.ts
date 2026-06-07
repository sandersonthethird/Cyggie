// Slack thread focus — per-thread "current entity" so a follow-up question
// can reuse that entity's already-loaded context instead of re-resolving and
// re-fetching it from scratch (External Agents V1 follow-up, Part 2).
//
// Two halves:
//   1. decideFocus(...) — a PURE function (no DB, no LLM) that decides whether
//      a follow-up should REUSE the thread's stored focus, SKIP injection, or
//      treat the thread as COLD. Unit-tested exhaustively.
//   2. getFocus / loadFocusName / upsertFocus — thin server-only repo over
//      slack_thread_focus (+ the focus entity's display name).
//
// Why name-based, not resolver-based: the cheap resolvers (resolveCompany/
// resolveContact) match the WHOLE query string against entity names, so a
// natural-language follow-up ("How's Beta doing?") resolves to `none` — the
// same signal as a true anaphor ("what's their burn?"). They can't spot an
// entity mid-sentence. So instead we look at the question text directly:
//   • does it MENTION the focus entity's name?            → REUSE
//   • does it name some OTHER proper noun (a likely        → SKIP (let the
//     different company/person)?                              agent load fresh)
//   • neither (pure anaphor / generic follow-up)?          → REUSE
// The agent still does the real entity resolution via its tools; this only
// gates whether we pre-inject the prior entity's context. SKIP is the
// "don't drag a different company's context in" guard.
//
// Capture flow (1A): the authoritative "what entity is this thread about" is
// whatever cyggie_get_context actually loaded (cyggieAsk surfaces it as
// loadedFocus). The handler upserts from that. On a pure REUSE turn the agent
// doesn't reload, so the handler just touches updatedAt to keep the focus warm.

import { eq, and } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../db'

// A follow-up within this window may reuse the thread's stored focus; past it
// the thread is treated as cold (fresh question). Comfortably longer than
// Anthropic's ~5-min prompt-cache window so most warm follow-ups still benefit.
export const FOCUS_TTL_MS = 15 * 60 * 1000

export type FocusEntityType = 'company' | 'contact'

export interface ThreadFocus {
  entityType: FocusEntityType
  entityId: string
  updatedAt: Date
}

export type FocusAction = 'reuse' | 'skip' | 'cold'

export interface FocusDecision {
  action: FocusAction
  // Only set for 'reuse' — the entity whose context block to rebuild + inject.
  // For skip/cold the agent loads fresh and the authoritative focus is
  // persisted from loadedFocus (1A).
  injectFocus: ThreadFocus | null
}

// PURE — no DB, no LLM, no clock (nowMs injected). See module header.
//   focusName: the stored focus entity's display name (canonicalName /
//   fullName), or null when it couldn't be loaded — then we can't detect a
//   re-mention of the focus, so we only reuse on pure anaphora.
export function decideFocus(args: {
  question: string
  currentFocus: ThreadFocus | null
  focusName: string | null
  nowMs: number
}): FocusDecision {
  const { question, currentFocus, focusName, nowMs } = args

  if (!currentFocus) return { action: 'cold', injectFocus: null }
  if (nowMs - currentFocus.updatedAt.getTime() > FOCUS_TTL_MS) {
    return { action: 'cold', injectFocus: null }
  }

  // The question explicitly names the focus entity → definitely about it.
  if (focusName && questionMentionsName(question, focusName)) {
    return { action: 'reuse', injectFocus: currentFocus }
  }

  // The question names some OTHER proper noun (a likely different entity) →
  // don't reuse the stale block; let the agent resolve + load it.
  if (hasOtherProperNoun(question, focusName)) {
    return { action: 'skip', injectFocus: null }
  }

  // No competing entity named → anaphoric / generic follow-up → reuse.
  return { action: 'reuse', injectFocus: currentFocus }
}

// ─── name / proper-noun heuristics (pure) ──────────────────────────────────

// Normalize a token/name for comparison: lowercase, accent-strip, drop a
// possessive 's, and trim surrounding punctuation.
function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['']s$/u, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

// True when the question text contains the focus entity's name as a normalized
// substring (handles "What's Acme's runway?" → mentions "acme").
export function questionMentionsName(question: string, name: string): boolean {
  const n = normalizeName(name)
  if (n.length < 2) return false
  return normalizeName(question).includes(n)
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

// Common capitalized sentence-openers / filler that are NOT entity names.
// Kept deliberately small + high-precision so a real proper noun is never
// stoplisted (we'd rather skip-on-uncertainty than carry stale context).
const STOPWORDS = new Set([
  'what', 'whats', 'how', 'hows', 'when', 'where', 'who', 'whos', 'why',
  'which', 'whose', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can',
  'could', 'should', 'would', 'will', 'has', 'have', 'had', 'tell', 'give',
  'show', 'list', 'get', 'find', 'summarize', 'summary', 'catch', 'recap',
  'the', 'a', 'an', 'and', 'or', 'but', 'also', 'please', 'cyggie', 'i',
])

// True when the question contains a proper-noun-like token that is NOT part of
// the focus entity's name — a signal the follow-up is about a different entity.
export function hasOtherProperNoun(question: string, focusName: string | null): boolean {
  const focusNorm = focusName ? normalizeName(focusName) : ''
  // Split on whitespace; inspect each token's ORIGINAL casing.
  for (const raw of question.split(/\s+/)) {
    // Proper-noun candidate: starts with an uppercase letter, len >= 2.
    if (!/^[A-ZÀ-ɏ][\p{L}\p{N}&.'-]+$/u.test(raw)) continue
    const norm = normalizeToken(raw)
    if (norm.length < 2) continue
    if (STOPWORDS.has(norm)) continue
    // Part of the focus name (either direction) → it's the focus, not "other".
    if (focusNorm && (focusNorm.includes(norm) || norm.includes(focusNorm))) continue
    return true
  }
  return false
}

// ─── server-only repo over slack_thread_focus ──────────────────────────────

export async function getFocus(
  db: ReturnType<typeof getDb>,
  sessionId: string,
): Promise<ThreadFocus | null> {
  const rows = await db
    .select({
      entityType: schema.slackThreadFocus.entityType,
      entityId: schema.slackThreadFocus.entityId,
      updatedAt: schema.slackThreadFocus.updatedAt,
    })
    .from(schema.slackThreadFocus)
    .where(eq(schema.slackThreadFocus.sessionId, sessionId))
    .limit(1)
  const r = rows[0]
  if (!r) return null
  if (r.entityType !== 'company' && r.entityType !== 'contact') return null
  return { entityType: r.entityType, entityId: r.entityId, updatedAt: r.updatedAt }
}

// Load the focus entity's display name (for the name-mention check), scoped to
// the user so a stale/cross-user id yields null (→ conservative reuse rules).
export async function loadFocusName(
  db: ReturnType<typeof getDb>,
  focus: ThreadFocus,
  userId: string,
): Promise<string | null> {
  if (focus.entityType === 'company') {
    const rows = await db
      .select({ name: schema.orgCompanies.canonicalName })
      .from(schema.orgCompanies)
      .where(and(eq(schema.orgCompanies.id, focus.entityId), eq(schema.orgCompanies.userId, userId)))
      .limit(1)
    return rows[0]?.name ?? null
  }
  const rows = await db
    .select({ name: schema.contacts.fullName })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, focus.entityId), eq(schema.contacts.userId, userId)))
    .limit(1)
  return rows[0]?.name ?? null
}

// Upsert the thread's focus (insert or replace, bumping updatedAt to now).
// Caller invokes this fire-and-forget — never await it in the response path.
export async function upsertFocus(
  db: ReturnType<typeof getDb>,
  args: { sessionId: string; entityType: FocusEntityType; entityId: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date()
  await db
    .insert(schema.slackThreadFocus)
    .values({
      sessionId: args.sessionId,
      entityType: args.entityType,
      entityId: args.entityId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.slackThreadFocus.sessionId,
      set: { entityType: args.entityType, entityId: args.entityId, updatedAt: now },
    })
}
