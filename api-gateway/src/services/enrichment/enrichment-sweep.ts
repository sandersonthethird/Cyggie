// enrichment-sweep — the gateway's "desktop is offline" FALLBACK for meeting CRM
// enrichment (T3 Slice 1). Desktop OWNS enrichment (it stamps enriched_at on its own
// triggers); this sweep only touches meetings that are STILL un-enriched after a
// window — i.e. ones desktop couldn't do.
//
// Trigger: request-piggybacked + throttled (Fly scales to zero, so a setInterval is
// unreliable). GET /sync/pull fires maybeRunEnrichmentSweep after responding; it runs
// at most once per THROTTLE_MS per process. The offline-desktop user is on mobile,
// which IS pulling — so it runs exactly when needed; when nobody pulls, nobody needs it.
//
// Gated behind env.GATEWAY_ENRICHMENT_ENABLED (default OFF).

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { buildCandidates, planCompanyNameUpdates, planMeetingEnrichment } from '@cyggie/db/meeting-enrichment/plan'
import { deriveSeedCompanyNames, extractEmailDomain } from '@cyggie/db/meeting-enrichment/helpers'
import { resolveCompanyName } from '@cyggie/services/meeting-enrichment/name'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import { GROUP_EVENT_ATTENDEE_THRESHOLD } from '@cyggie/shared'
import { getDb } from '../../db'
import type { GatewayEnv } from '../../env'
import { resolveAnthropicKey } from '../../llm/resolve-key'
import { makeGatewayClaudeProvider } from '../../llm/gateway-claude-provider'
import { applyCompanyNameUpdates, applyWritePlan, loadExistingState } from './pg-enrichment-store'

/** Per-owner LLM provider factory (null = no key → name resolution skipped). */
export type LlmForUser = (ownerUserId: string) => Promise<LLMProvider | null>

const MAX_DOMAINS_PER_MEETING = 10 // cap LLM calls per meeting

type Db = ReturnType<typeof getDb>

const THROTTLE_MS = 5 * 60 * 1000 // at most one sweep per 5 min per process
const SWEEP_LIMIT = 10 // bound work per pass (pool safety)
const MIN_AGE_MS = 30 * 60 * 1000 // give desktop ~30 min to do it first
const MAX_ATTEMPTS = 3 // dead-letter after N failures (poison-meeting guard)

export interface SweepResult {
  processed: number
  enriched: number
  failed: number
}

export interface SweepOptions {
  limit?: number
  minAgeMs?: number
  maxAttempts?: number
  /** Scope the sweep to one firm — test isolation only; production runs global. */
  firmId?: string
  /** Per-owner LLM provider (Slice 2 name resolution). Absent/returns-null → skip naming. */
  llmFor?: LlmForUser
  /** Injected logger; defaults to console. */
  log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }
}

let lastSweptAt = 0

/** Production entry: flag-gated + throttled, called fire-and-forget from /sync/pull. */
export async function maybeRunEnrichmentSweep(env: GatewayEnv): Promise<void> {
  if (!env.GATEWAY_ENRICHMENT_ENABLED) return
  const now = Date.now()
  if (now - lastSweptAt < THROTTLE_MS) return
  lastSweptAt = now
  // Per-owner Anthropic key → a GatewayClaudeProvider; null when the user has no key
  // (single-firm beta: resolveAnthropicKey falls back to the env key).
  const llmFor: LlmForUser = async (ownerUserId) => {
    const key = await resolveAnthropicKey(env, ownerUserId)
    return key ? makeGatewayClaudeProvider(key) : null
  }
  try {
    await runEnrichmentSweep(getDb(env.GATEWAY_DATABASE_URL), { llmFor })
  } catch (err) {
    console.error('[enrichment-sweep] pass failed', err)
  }
}

/** One sweep pass — exported (no flag/throttle) so tests can drive it deterministically. */
export async function runEnrichmentSweep(db: Db, opts: SweepOptions = {}): Promise<SweepResult> {
  const limit = opts.limit ?? SWEEP_LIMIT
  const minAgeMs = opts.minAgeMs ?? MIN_AGE_MS
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
  const log = opts.log ?? console
  const result: SweepResult = { processed: 0, enriched: 0, failed: 0 }

  const cutoff = new Date(Date.now() - minAgeMs)
  const eligible = await db
    .select({
      id: schema.meetings.id,
      userId: schema.meetings.userId,
      firmId: schema.meetings.firmId,
      attendees: schema.meetings.attendees,
      attendeeEmails: schema.meetings.attendeeEmails,
      isGroupEvent: schema.meetings.isGroupEvent,
    })
    .from(schema.meetings)
    .where(
      and(
        isNull(schema.meetings.enrichedAt),
        isNotNull(schema.meetings.firmId),
        isNotNull(schema.meetings.calendarEventId),
        lt(schema.meetings.createdAt, cutoff),
        or(isNull(schema.meetings.enrichAttempts), lt(schema.meetings.enrichAttempts, maxAttempts)),
        opts.firmId ? eq(schema.meetings.firmId, opts.firmId) : undefined,
      ),
    )
    .orderBy(schema.meetings.createdAt)
    .limit(limit)

  // One domain→name cache per pass — a domain shared across meetings hits the LLM once.
  const domainCache = new Map<string, string>()
  for (const m of eligible) {
    result.processed += 1
    try {
      await enrichOneMeeting(db, m, { llmFor: opts.llmFor, domainCache, log })
      result.enriched += 1
    } catch (err) {
      result.failed += 1
      log.error({ meetingId: m.id, userId: m.userId, firmId: m.firmId, err, metric: 'enrichment.sweep.error' }, 'enrichment sweep: meeting failed')
      // Bump the attempt counter WITHOUT a lamport bump (gateway-internal, not pulled).
      await db
        .update(schema.meetings)
        .set({ enrichAttempts: sql`coalesce(${schema.meetings.enrichAttempts}, 0) + 1` })
        .where(eq(schema.meetings.id, m.id))
        .catch(() => {})
    }
  }

  if (result.processed > 0) {
    log.info({ ...result, metric: 'enrichment.sweep.complete' }, 'enrichment sweep complete')
  }
  return result
}

interface EligibleMeeting {
  id: string
  userId: string
  firmId: string | null
  attendees: unknown
  attendeeEmails: unknown
  isGroupEvent: boolean
}

interface EnrichCtx {
  llmFor?: LlmForUser
  domainCache: Map<string, string>
  log: NonNullable<SweepOptions['log']>
}

async function enrichOneMeeting(db: Db, m: EligibleMeeting, ctx: EnrichCtx): Promise<void> {
  const firmId = m.firmId
  if (!firmId) return // filtered out by the query, but keep the type narrow

  const ownerRow = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, m.userId))
    .limit(1)
  const ownerEmail = ownerRow[0]?.email ?? null

  const attendees = asStringArray(m.attendees)
  const attendeeEmails = asStringArray(m.attendeeEmails)
  // Parity with desktop's prepareMeetingFromCalendarEvent: a stored group flag OR the
  // attendee-count heuristic. A group event yields an EMPTY plan (no CRM seeding).
  const isGroupEvent = m.isGroupEvent || attendeeEmails.length > GROUP_EVENT_ATTENDEE_THRESHOLD

  const candidates = buildCandidates(attendees, attendeeEmails, ownerEmail)
  const seedNames = deriveSeedCompanyNames(attendees, attendeeEmails)
  const loaded = await loadExistingState(db, {
    firmId,
    candidateEmails: candidates.map((c) => c.email),
    seedNames,
    attendeeEmails,
    meetingId: m.id,
  })
  const plan = planMeetingEnrichment(loaded.state, { attendees, attendeeEmails }, {
    meetingId: m.id,
    ownerEmail,
    isGroupEvent,
    companies: undefined,
  })

  const { seedKeyToId } = await applyWritePlan(db, { userId: m.userId, firmId, plan, loaded, attendeeEmails })

  // Slice 2 — resolve REAL company names (created companies only). Best-effort: a
  // failure leaves the seed/heuristic name but never blocks markEnriched.
  // resolveCompanyName always returns a name (heuristic on LLM failure); when the
  // resolved name equals the seed, planCompanyNameUpdates emits nothing → no-op.
  if (ctx.llmFor) {
    try {
      const llm = await ctx.llmFor(m.userId)
      if (llm) {
        const domains = [
          ...new Set(attendeeEmails.map((e) => extractEmailDomain(e)).filter((d): d is string => Boolean(d))),
        ].slice(0, MAX_DOMAINS_PER_MEETING)
        const resolved: Array<{ domain: string; name: string }> = []
        for (const domain of domains) {
          let name = ctx.domainCache.get(domain)
          if (name === undefined) {
            name = await resolveCompanyName(domain, { fetchHtml: async () => null, llm })
            ctx.domainCache.set(domain, name)
          }
          resolved.push({ domain, name })
        }
        if (resolved.length > 0) {
          const updates = planCompanyNameUpdates(plan, loaded.state, resolved)
          await applyCompanyNameUpdates(db, { firmId, updates, seedKeyToId })
        }
      }
    } catch (err) {
      ctx.log.error({ meetingId: m.id, err, metric: 'enrichment.sweep.name_resolution_error' }, 'name resolution failed (non-fatal)')
    }
  }

  // Mark done AFTER the apply commits, with a lamport bump so it pulls to desktop
  // (the row was created with lamport '0'). The desktop guard then skips re-enriching.
  await db
    .update(schema.meetings)
    .set({ enrichedAt: new Date(), lamport: String(Date.now()), updatedAt: new Date() })
    .where(eq(schema.meetings.id, m.id))
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
