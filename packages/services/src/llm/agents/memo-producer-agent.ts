/**
 * Memo Producer Agent.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Wraps runAgentLoop with the memo-producer system prompt + tools.    │
 *   │  Iterates the section roster, calls tools to research per section,   │
 *   │  buffers evidence + section bodies, then calls done() to terminate.  │
 *   │                                                                       │
 *   │  Caller flow (IPC handler):                                            │
 *   │    1. await runMemoProducerAgent({...})                                │
 *   │    2. on success → persistMemoArtifacts (memo version + evidence)     │
 *   │    3. emit AgentEvent {type: 'done', versionId}                        │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Run lifecycle:                                                       │
 *   │    gather    → load company + meetings + notes + contacts + files    │
 *   │    pre-research (Exa) → competitors + LinkedIn fetches               │
 *   │    allocate context  → token-count, displace older transcripts to    │
 *   │                         Haiku-summaries if over budget                │
 *   │    filter roster     → drop Valuation if not Series A+,              │
 *   │                         drop References if no reference calls         │
 *   │    seed allowlist    → contact linkedinUrls + Exa result URLs        │
 *   │    runAgentLoop      → tools iterate sections; done() terminates     │
 *   │    assemble          → sort by ordinal, strip <thinking> blocks      │
 *   │    threshold check   → < 3 sections submitted → fail (no DB writes)  │
 *   │    persist           → memo version + evidence rows, one transaction │
 *   └──────────────────────────────────────────────────────────────────────┘
 */

import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoop, type AgentRunResult } from './agent-loop'
import { buildMemoProducerTools, type MemoProducerRunState } from './memo-producer-tools'
import { getAgentLimits, type AgentLimits } from './limits'
import { getCredential } from '@main/security/credentials'
import { getSetting } from '@cyggie/db/sqlite/repositories/settings.repo'
import {
  getAgentModelId,
  getAgentPricing,
  getCacheTtl,
  HAIKU_MODEL_ID,
  EXTENDED_CACHE_TTL_BETA,
} from './model-tier'
import type { AgentEvent } from '@shared/types/agent-events'
import type { EvidenceRow } from '@shared/types/thesis'
import {
  MEMO_SECTIONS,
  type MemoSection,
  type MemoSectionHeading,
  isSeriesAOrLater,
  canonicalizeUrl,
  normalizeLegacyHeadings,
  replaceSectionInMarkdown,
} from '../memo/sections'
import { listByVersion as listEvidenceByVersion } from '@cyggie/db/sqlite/repositories/memo-evidence.repo'
import type { StoredMemoEvidence } from '@shared/types/memo-evidence'
import { allocateContext, type MeetingTranscriptInput, ContextOverflowError } from '../memo/context-budget'
import { persistMemoArtifacts } from '../memo/persist'
import { searchCompanyContext, type ExternalResearchBundle } from '@cyggie/services/exa-research'
// Vite ?raw inlines the markdown content as a string at build time.
import MEMO_PRODUCER_SYSTEM_PROMPT_TEMPLATE from './prompts/memo-producer.system.md?raw'
import INVESTMENT_CRITERIA from './prompts/investment-criteria.md?raw'

import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import * as memoRepo from '@cyggie/db/sqlite/repositories/investment-memo.repo'
import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import { getFlaggedFiles } from '@cyggie/db/sqlite/repositories/company-file-flags.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { readSummary, readTranscript } from '@main/storage/file-manager'

const SETTING_EXTENDED_THINKING = 'agent.memoProducerExtendedThinking'
const _companyNotesRepo = makeEntityNotesRepo('company_id')

/** Below this section count, we don't persist anything. */
export const MIN_SECTIONS_TO_PERSIST = 3

/** Matches our placeholder convention `###CAPS_AND_UNDERSCORES###` — not markdown h3. */
const PLACEHOLDER_PATTERN = /###[A-Z_]+###/

/**
 * Build the memo-producer system prompt by substituting placeholders.
 * Throws if any placeholder remains unsubstituted — this guards against
 * silent failures where a placeholder is renamed in the markdown but
 * not in this file (or vice versa).
 */
export function buildMemoProducerSystemPrompt(sectionRoster: readonly MemoSection[]): string {
  const rosterBlock = sectionRoster
    .map((s) => `${s.ordinal}. **${s.heading}** (${s.kind}${s.required ? ', required' : ', optional'})`)
    .join('\n')
  const prompt = MEMO_PRODUCER_SYSTEM_PROMPT_TEMPLATE
    .replace('###SECTION_ROSTER###', rosterBlock)
    .replace('###INVESTMENT_CRITERIA###', INVESTMENT_CRITERIA)
  const leftover = prompt.match(PLACEHOLDER_PATTERN)
  if (leftover) {
    throw new Error(`Unsubstituted prompt placeholder in memo-producer system prompt: ${leftover[0]}`)
  }
  return prompt
}

export interface RunMemoProducerInput {
  runId: string
  companyId: string
  memoId: string
  userId: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  limits?: AgentLimits
  /**
   * Targeted update: regenerate ONLY `targetSections` and splice them back into
   * the existing memo (rather than rebuilding the whole memo from the roster).
   * Drives both:
   *   • per-section Refresh — `{ targetSections: [heading] }`, no new material
   *   • incorporate-new-material — also sets `newMeetingIds`/`newNotes`/`newEmails`,
   *     which slim the context to just the new call(s)/notes/emails + the
   *     existing memo (prior transcripts are already baked into the memo).
   * `MIN_SECTIONS_TO_PERSIST` is effectively 1 in this mode. The merge skips any
   * targeted heading absent from the memo and persists NOTHING if zero sections
   * actually changed (guards the blank-memo regression).
   */
  targetedUpdate?: TargetedUpdate
}

export interface TargetedUpdate {
  targetSections: MemoSectionHeading[]
  /** When set, only these meetings' transcripts are fed (the "new calls"). */
  newMeetingIds?: string[]
  /** New company notes since the last memo version (slim context). */
  newNotes?: Array<{ title: string | null; content: string }>
  /** New company emails since the last memo version (slim context). */
  newEmails?: Array<{ subject: string | null; from: string; date: string | null; body: string }>
}

/** Defensive cap on new notes/emails text folded into the slim context. */
const NEW_MATERIAL_CHAR_CAP = 40_000

export interface RunMemoProducerResult extends AgentRunResult {
  /** When status==='success', the assembled memo markdown ready to persist. */
  assembledMarkdown?: string
  /** When status==='success', the evidence rows the agent emitted via cite_source. */
  evidenceRows: EvidenceRow[]
  /** Section headings the agent successfully submitted (in roster order). */
  sectionsSubmitted: MemoSectionHeading[]
  /** Sections that were required but never submitted. */
  sectionsMissing: MemoSectionHeading[]
  /** Persisted version id when persistence ran; null on threshold-fail or pre-persist abort. */
  resultVersionId: string | null
  /** Counts surfaced in the IPC response for the renderer's footer. */
  meta: {
    contextTokensEstimated: number
    transcriptsKept: number
    transcriptsDisplaced: number
    summaryCacheHits: number
    summaryCacheMisses: number
    externalResearchQueryCount: number
    externalResearchResultCount: number
    evidenceRowCount: number
  }
}

export async function runMemoProducerAgent(
  input: RunMemoProducerInput,
): Promise<RunMemoProducerResult> {
  // Prefer the memo-specific key so users can isolate high-token agent flows
  // onto a dedicated Anthropic account; fall back to the main Claude key.
  const apiKey = getCredential('memoApiKey') || getCredential('claudeApiKey')
  if (!apiKey) {
    return emptyResult(
      'AuthenticationError',
      'No Claude API key configured. Set one under Settings → AI & Transcription (main Anthropic key or the memo-specific override).',
    )
  }
  const model = getAgentModelId()
  const cacheTtl = getCacheTtl()
  // 1h cache TTL requires the extended-cache-ttl beta header. If the account
  // isn't entitled the API returns 400; user can flip agent.cacheTtl back to
  // '5m' in Settings as the safe fallback.
  const client = new Anthropic({
    apiKey,
    ...(cacheTtl === '1h'
      ? { defaultHeaders: { 'anthropic-beta': EXTENDED_CACHE_TTL_BETA } }
      : {}),
  })
  const limits = input.limits ?? getAgentLimits()
  const extendedThinkingEnabled = getSetting(SETTING_EXTENDED_THINKING) !== 'false' // default true

  // ─── Gather company + data ────────────────────────────────────────────
  const company = companyRepo.getCompany(input.companyId)
  if (!company) {
    return emptyResult('CompanyNotFound', `company not found: ${input.companyId}`)
  }

  // Targeted update (per-section Refresh / incorporate-new-material): only the
  // listed sections are regenerated and spliced into the existing memo. When
  // `newMeetingIds` is set we feed ONLY those transcripts (the new calls) — prior
  // calls are already baked into the memo.
  const targeted = input.targetedUpdate
  const targetSet = targeted ? new Set<string>(targeted.targetSections) : null
  const meetingFilter = targeted?.newMeetingIds ? new Set(targeted.newMeetingIds) : null

  const meetingsRaw = companyRepo.listCompanyMeetings(input.companyId)
  const summaryPaths = companyRepo.listCompanyMeetingSummaryPaths(input.companyId)
  const summaryByMeetingId = new Map(summaryPaths.map((s) => [s.meetingId, s.summaryPath]))
  const meetingsWithSummary = new Set(summaryByMeetingId.keys())

  // Producer agent sees FULL transcripts for every meeting that has one.
  // Context budget will displace older transcripts to summarized form if the
  // total blows past 180k tokens. In incorporate mode, `meetingFilter` narrows
  // this to just the new call(s).
  const transcriptInputs: MeetingTranscriptInput[] = []
  for (const m of meetingsRaw) {
    if (meetingFilter && !meetingFilter.has(m.id)) continue
    const meeting = meetingRepo.getMeeting(m.id)
    if (!meeting?.transcriptPath) continue
    const content = readTranscript(meeting.transcriptPath)
    if (!content) continue
    transcriptInputs.push({
      id: m.id,
      title: m.title,
      date: m.date,
      transcriptPath: meeting.transcriptPath,
      content,
    })
  }

  // Notes (company-tagged).
  const notes = _companyNotesRepo.list(input.companyId)
  // Contacts with LinkedIn URLs feed direct fetches.
  const linkedContacts = companyRepo
    .listCompanyContacts(input.companyId)
    .slice()
    .sort((a, b) => (b.meetingCount ?? 0) - (a.meetingCount ?? 0))
  const linkedinContacts = linkedContacts
    .filter((c) => c.linkedinUrl?.trim() && c.fullName?.trim())
    .slice(0, 8)
    .map((c) => ({ name: c.fullName, url: c.linkedinUrl! }))

  // Flagged Drive files — refs only; agent fetches content via read_document.
  const flagged = getFlaggedFiles(input.companyId)

  // Existing memo, if any. Normalize legacy headings up front so the targeted
  // merge can splice by canonical heading (e.g. "Investment Highlights" →
  // "Investment Thesis"); this is also the merge base in targeted mode.
  const existingVersion = memoRepo.getMemoLatestVersion(input.memoId)
  const existingMemoMarkdown = normalizeLegacyHeadings(existingVersion?.contentMarkdown ?? '')

  // Founder names for Exa fallback (when no linkedinUrl on a contact).
  const FOUNDER_TITLE_RE = /founder|ceo|cto|coo|chief/i
  const titledFounders = linkedContacts.filter((c) => FOUNDER_TITLE_RE.test(c.title ?? ''))
  const founderNames =
    titledFounders.length > 0
      ? titledFounders.slice(0, 2).map((c) => c.fullName)
      : linkedContacts.filter((c) => c.isPrimary).slice(0, 2).map((c) => c.fullName)

  // Niche signal: most recent summary's first 500 chars.
  const summariesByDateDesc = summaryPaths // already date DESC per repo contract
  const nicheSignal = summariesByDateDesc[0]
    ? (readSummary(summariesByDateDesc[0].summaryPath) ?? '').slice(0, 500)
    : null

  // ─── Exa pre-research (best-effort) ────────────────────────────────────
  // Skipped in targeted mode: the memo already has its research/competition
  // sections, and a targeted update should be fast + cheap.
  let externalResearch: ExternalResearchBundle = { queries: [], results: [] }
  if (!targeted) {
    try {
      externalResearch = await searchCompanyContext(
        {
          companyName: company.canonicalName,
          companyDescription: company.description,
          primaryDomain: company.primaryDomain,
          industry: company.industry,
          themes: company.themes,
          nicheSignal,
          founderNames,
          linkedinContacts,
        },
        input.signal,
      )
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return emptyResult('AbortError', 'aborted before agent loop started')
      }
      console.warn('[memo-producer] Exa pre-research failed (continuing):', (err as Error).message)
    }
  }

  // ─── Filter section roster by gates ───────────────────────────────────
  const seriesAPlus = isSeriesAOrLater(company.stage)
  const hasReferenceCalls = /reference call|reference\s+(check|conversation)/i.test(
    summariesByDateDesc.map((s) => s.title).join(' '),
  )
  const fullRoster = MEMO_SECTIONS.filter((s) => {
    if (targetSet) return targetSet.has(s.heading)
    if (s.gate === 'series_a_plus') return seriesAPlus
    if (s.gate === 'has_reference_calls') return hasReferenceCalls
    return true
  })
  const sectionRoster: readonly MemoSection[] = fullRoster

  // ─── Allocate context (token-counted; may displace transcripts) ──────
  // Scaffold = company overview + notes + contact profiles + file refs +
  // existing memo + external research, all in one string used both for token
  // counting and the agent's initial user message. In targeted mode the full
  // notes corpus and the existing-memo block are suppressed here — the new
  // notes/emails + the full existing memo go in the initial user message
  // instead (slim context; avoids duplicating the memo).
  const scaffold = buildScaffold({
    company,
    notes: targeted ? [] : notes.filter((n) => n.content?.trim()),
    contacts: linkedContacts,
    files: flagged,
    existingMemoMarkdown,
    suppressExistingMemo: !!targeted,
    externalResearch,
  })

  let allocated
  try {
    allocated = await allocateContext({
      anthropic: client,
      model,
      meetings: transcriptInputs,
      scaffold,
      summarize: async (m) => summarizeTranscriptWithHaiku(client, m),
    })
  } catch (err) {
    if (err instanceof ContextOverflowError) {
      return emptyResult('ContextOverflow', err.message)
    }
    throw err
  }

  // ─── Build per-run state for tools ────────────────────────────────────
  const webFetchAllowlist = new Set<string>()
  for (const c of linkedinContacts) {
    const canon = canonicalizeUrl(c.url)
    if (canon) webFetchAllowlist.add(canon)
  }
  for (const r of externalResearch.results) {
    const canon = canonicalizeUrl(r.url)
    if (canon) webFetchAllowlist.add(canon)
  }

  const state: MemoProducerRunState = {
    companyId: input.companyId,
    companyName: company.canonicalName,
    webFetchAllowlist,
    evidenceBuffer: [],
    submittedSections: new Map(),
    sectionRoster,
    emit: input.emit,
  }

  const systemPrompt = buildMemoProducerSystemPrompt(sectionRoster)

  // Build initial user message: scaffold + raw transcripts + summarized older
  // ones. In targeted mode it also carries the full existing memo + new
  // notes/emails and the "update only these sections" instruction.
  const initialUserMessage = buildInitialUserMessage({
    scaffold,
    rawTranscripts: allocated.rawTranscripts,
    summarizedTranscripts: allocated.summarizedTranscripts,
    targeted,
    existingMemoMarkdown,
  })

  // ─── Run agent loop ────────────────────────────────────────────────────
  const tools = buildMemoProducerTools(state)
  const result = await runAgentLoop({
    client,
    model,
    systemPrompt,
    initialUserMessage,
    tools,
    ctx: {
      companyId: input.companyId,
      userId: input.userId,
      runId: input.runId,
      signal: input.signal,
    },
    limits,
    emit: input.emit,
    signal: input.signal,
    runId: input.runId,
    kind: 'memo_producer',
    mode: 'cold',
    companyId: input.companyId,
    enableThinking: extendedThinkingEnabled,
    thinkingBudgetTokens: 2048,
    cacheTtl,
    pricing: getAgentPricing(),
  })

  // ─── Assemble + threshold check ───────────────────────────────────────
  const submittedHeadings = Array.from(state.submittedSections.keys())
  const requiredMissing = sectionRoster
    .filter((s) => s.required && !state.submittedSections.has(s.heading))
    .map((s) => s.heading)

  const baseMeta = {
    contextTokensEstimated: allocated.estimatedTokens,
    transcriptsKept: allocated.meta.transcriptsKept,
    transcriptsDisplaced: allocated.meta.transcriptsDisplaced,
    summaryCacheHits: allocated.meta.summaryCacheHits,
    summaryCacheMisses: allocated.meta.summaryCacheMisses,
    externalResearchQueryCount: externalResearch.queries.length,
    externalResearchResultCount: externalResearch.results.length,
    evidenceRowCount: state.evidenceBuffer.length,
  }

  // If the loop status itself is non-success (aborted, cap_exceeded, error),
  // bail out without persistence — but DO return the partial section list so
  // the caller can surface it in telemetry.
  if (result.status !== 'success') {
    return {
      ...result,
      evidenceRows: state.evidenceBuffer,
      sectionsSubmitted: submittedHeadings,
      sectionsMissing: requiredMissing,
      resultVersionId: null,
      meta: baseMeta,
    }
  }

  const minRequired = targeted ? 1 : MIN_SECTIONS_TO_PERSIST
  if (state.submittedSections.size < minRequired) {
    return {
      ...result,
      status: 'failed',
      errorClass: 'TooFewSections',
      errorMessage: `producer agent submitted only ${state.submittedSections.size} sections (minimum ${minRequired})`,
      evidenceRows: state.evidenceBuffer,
      sectionsSubmitted: submittedHeadings,
      sectionsMissing: requiredMissing,
      resultVersionId: null,
      meta: baseMeta,
    }
  }

  // ─── Assemble: targeted = splice into existing memo; full = rebuild ──────
  //
  //   targeted:   base memo ──▶ replaceSectionInMarkdown(×submitted, in order)
  //               heading absent ─▶ skip (log), never throw
  //               0 applied ──────▶ NoChanges (persist nothing)
  //   full:       assembleMemo(roster, submitted)  ◀── unchanged
  //
  let assembled: string
  let evidenceRows = state.evidenceBuffer
  if (targeted) {
    const { merged, applied } = spliceTargetedSections(
      existingMemoMarkdown,
      sectionRoster,
      state.submittedSections,
    )
    if (applied === 0) {
      // No-op guard: none of the targeted sections were applied (e.g. all were
      // absent from the memo). Persist NOTHING — this is the blank-memo guard.
      return {
        ...result,
        status: 'failed',
        errorClass: 'NoChanges',
        errorMessage: 'no targeted sections were applied to the memo',
        evidenceRows: state.evidenceBuffer,
        sectionsSubmitted: submittedHeadings,
        sectionsMissing: requiredMissing,
        resultVersionId: null,
        meta: baseMeta,
      }
    }
    assembled = merged
    // Evidence carry-forward: a targeted run only emits evidence for the updated
    // sections, but we persist a NEW version of the WHOLE memo. Without this,
    // untouched sections would silently lose their citations.
    if (existingVersion) {
      const carried = carryForwardEvidence(listEvidenceByVersion(existingVersion.id), targetSet!)
      evidenceRows = [...carried, ...state.evidenceBuffer]
    }
  } else {
    assembled = assembleMemo(company.canonicalName, sectionRoster, state.submittedSections)
  }

  const isIncorporate = !!(
    targeted &&
    ((targeted.newMeetingIds?.length ?? 0) +
      (targeted.newNotes?.length ?? 0) +
      (targeted.newEmails?.length ?? 0) >
      0)
  )
  const changeNote = !targeted
    ? 'Generated by producer agent'
    : isIncorporate
      ? `Incorporated new material into ${targeted.targetSections.length} section(s)`
      : `Refreshed section: ${targeted.targetSections[0]}`

  // ─── Persist (transactionally) ────────────────────────────────────────
  let resultVersionId: string | null = null
  try {
    const persisted = persistMemoArtifacts({
      memoId: input.memoId,
      contentMarkdown: assembled,
      changeNote,
      userId: input.userId,
      evidenceRows,
    })
    resultVersionId = persisted.versionId
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      ...result,
      status: 'failed',
      errorClass: 'PersistError',
      errorMessage: errMsg,
      evidenceRows: state.evidenceBuffer,
      sectionsSubmitted: submittedHeadings,
      sectionsMissing: requiredMissing,
      resultVersionId: null,
      meta: baseMeta,
    }
  }

  return {
    ...result,
    assembledMarkdown: assembled,
    evidenceRows: state.evidenceBuffer,
    sectionsSubmitted: submittedHeadings,
    sectionsMissing: requiredMissing,
    resultVersionId,
    meta: baseMeta,
  }
}

// ─── Scaffold + initial user message builders ────────────────────────────

function buildScaffold(args: {
  company: ReturnType<typeof companyRepo.getCompany>
  notes: ReturnType<typeof _companyNotesRepo.list>
  contacts: ReturnType<typeof companyRepo.listCompanyContacts>
  files: ReturnType<typeof getFlaggedFiles>
  existingMemoMarkdown: string
  /**
   * Targeted mode passes the FULL existing memo in the initial user message
   * instead, so suppress the truncated "Existing Memo Draft" block here to
   * avoid duplicating the memo (token waste + truncated/full confusion).
   */
  suppressExistingMemo?: boolean
  externalResearch: ExternalResearchBundle
}): string {
  const parts: string[] = []
  const c = args.company
  if (!c) return ''
  parts.push(`# Company: ${c.canonicalName}`)
  if (c.description) parts.push(`Description: ${c.description}`)
  const detailParts: string[] = []
  if (c.city || c.state) detailParts.push(`Location: ${[c.city, c.state].filter(Boolean).join(', ')}`)
  if (c.round) detailParts.push(`Round: ${c.round}`)
  if (c.raiseSize) detailParts.push(`Raise: $${c.raiseSize.toFixed(1)}M`)
  if (c.postMoneyValuation) detailParts.push(`Post-money: $${c.postMoneyValuation.toFixed(1)}M`)
  if (c.stage) detailParts.push(`Stage: ${c.stage}`)
  if (c.industry) detailParts.push(`Industry: ${c.industry}`)
  if (c.themes?.length) detailParts.push(`Themes: ${c.themes.join(', ')}`)
  if (detailParts.length) parts.push(detailParts.join(' | '))

  if (args.notes.length > 0) {
    parts.push('\n---\n## Company Notes\n')
    for (const n of args.notes) {
      if (!n.content?.trim()) continue
      parts.push((n.title ? `**${n.title}**\n` : '') + n.content)
      parts.push('')
    }
  }

  if (args.contacts.length > 0) {
    parts.push('\n---\n## Contact Profiles\n')
    for (const ct of args.contacts.slice(0, 8)) {
      const header = `### ${ct.fullName}${ct.title ? ` — ${ct.title}` : ''}`
      const linkedinLine = ct.linkedinUrl ? `LinkedIn: ${ct.linkedinUrl}` : ''
      const takeaways = ct.keyTakeaways?.trim() ? ct.keyTakeaways.slice(0, 800) : ''
      parts.push([header, linkedinLine, takeaways].filter(Boolean).join('\n'))
    }
  }

  if (args.files.length > 0) {
    parts.push('\n---\n## Flagged Drive Files\n')
    parts.push('Available via `read_document(file_name)`:')
    for (const f of args.files) {
      parts.push(`- ${f.fileName}${f.mimeType ? ` (${f.mimeType})` : ''}`)
    }
  }

  if (!args.suppressExistingMemo && args.existingMemoMarkdown.trim()) {
    parts.push('\n---\n## Existing Memo Draft (incorporate and improve)\n')
    parts.push(args.existingMemoMarkdown.slice(0, 6000))
  }

  if (args.externalResearch.results.length > 0) {
    parts.push('\n---\n## External Research (web — cite inline as [source: url])\n')
    const byQuery = new Map<string, typeof args.externalResearch.results>()
    for (const r of args.externalResearch.results) {
      const list = byQuery.get(r.query) ?? []
      list.push(r)
      byQuery.set(r.query, list)
    }
    for (const [query, results] of byQuery) {
      parts.push(`### Search: "${query}"\n`)
      for (const r of results) {
        parts.push(`**${r.title ?? r.url}** ${r.publishedDate ? `(${r.publishedDate})` : ''}\n${r.url}\n${r.text}\n`)
      }
    }
  }

  return parts.join('\n')
}

function buildInitialUserMessage(args: {
  scaffold: string
  rawTranscripts: Array<{ id: string; title: string; date: string; content: string }>
  summarizedTranscripts: Array<{ id: string; title: string; date: string; summary: string }>
  targeted?: TargetedUpdate
  /** Full (normalized) existing memo — included verbatim in targeted mode. */
  existingMemoMarkdown: string
}): string {
  const parts: string[] = []
  parts.push(args.scaffold)

  // In targeted mode, the transcripts here are ONLY the new call(s). Label them
  // as such and give the agent the full current memo + new notes/emails.
  const transcriptHeading = args.targeted
    ? '\n---\n## New Call Transcript(s) — since the last memo\n'
    : '\n---\n## Meeting Transcripts (full text)\n'
  if (args.rawTranscripts.length > 0) {
    parts.push(transcriptHeading)
    for (const t of args.rawTranscripts) {
      parts.push(`### ${t.title} (${t.date})\n${t.content}`)
    }
  }

  if (args.summarizedTranscripts.length > 0) {
    parts.push('\n---\n## Meeting Summaries (older meetings, condensed)\n')
    for (const t of args.summarizedTranscripts) {
      parts.push(`### ${t.title} (${t.date})\n${t.summary}`)
    }
  }

  if (args.targeted) {
    // New notes / emails (capped) — the rest of the "new material" delta.
    const newMaterial: string[] = []
    let budget = NEW_MATERIAL_CHAR_CAP
    for (const n of args.targeted.newNotes ?? []) {
      const text = (n.title ? `**${n.title}**\n` : '') + n.content
      if (budget - text.length < 0) break
      budget -= text.length
      newMaterial.push(text)
    }
    if (newMaterial.length > 0) {
      parts.push('\n---\n## New Notes — since the last memo\n')
      parts.push(newMaterial.join('\n\n'))
    }
    const newEmails: string[] = []
    for (const e of args.targeted.newEmails ?? []) {
      const text = `**${e.subject ?? '(no subject)'}** — ${e.from}${e.date ? ` (${e.date})` : ''}\n${e.body}`
      if (budget - text.length < 0) break
      budget -= text.length
      newEmails.push(text)
    }
    if (newEmails.length > 0) {
      parts.push('\n---\n## New Emails — since the last memo\n')
      parts.push(newEmails.join('\n\n'))
    }

    parts.push('\n---\n## Current Memo (full — preserve everything not listed below)\n')
    parts.push(args.existingMemoMarkdown)

    const sectionList = args.targeted.targetSections.map((s) => `"${s}"`).join(', ')
    parts.push(
      `\n---\nMODE: targeted-update\n` +
        `Update ONLY these sections to reflect the new material above: ${sectionList}. ` +
        `Re-emit each as a complete, self-contained section via submit_section (you may ` +
        `reuse unchanged prose from the current memo). cite_source factual claims. ` +
        `Do NOT touch any other section. done({}) when the listed sections are submitted.`,
    )
  } else {
    parts.push(
      '\n---\nProduce the memo section by section. Use internal_search and read_document for internal data; web_search and web_fetch for external claims. cite_source every factual claim. submit_section once per section in roster order. done({}) when complete.',
    )
  }

  return parts.join('\n')
}

// ─── Memo assembly ───────────────────────────────────────────────────────

const THINKING_BLOCK_RE = /^\s*<thinking>[\s\S]*?<\/thinking>\s*/

function stripLeadingThinking(body: string): string {
  return body.replace(THINKING_BLOCK_RE, '').trimStart()
}

function buildTitle(companyName: string): string {
  return `# ${companyName} — Investment Memo`
}

// ─── Targeted merge (per-section Refresh + incorporate-new-material) ─────────

/**
 * Splice the submitted target sections into the base memo, in roster order.
 * Headings absent from the base are SKIPPED (logged), never thrown. Returns the
 * merged markdown and how many sections actually changed (`applied === 0` is the
 * no-op case — caller persists nothing). Pure + unit-tested: this is the path
 * that previously shipped the blank-memo bug.
 */
export function spliceTargetedSections(
  baseMarkdown: string,
  roster: readonly MemoSection[],
  submitted: Map<MemoSectionHeading, { body: string }>,
): { merged: string; applied: number } {
  let merged = baseMarkdown
  let applied = 0
  for (const s of [...roster].sort((a, b) => a.ordinal - b.ordinal)) {
    const entry = submitted.get(s.heading)
    if (!entry) continue
    const body = s.kind === 'synthesis' ? stripLeadingThinking(entry.body) : entry.body
    try {
      merged = replaceSectionInMarkdown(merged, s.heading, body)
      applied += 1
    } catch {
      console.warn(`[memo-incorporate] section "${s.heading}" not in memo — skipped`)
    }
  }
  return { merged, applied }
}

/**
 * Evidence rows to persist for the NEW version produced by a targeted update:
 * carry forward the prior version's rows for sections NOT being updated (and
 * section-less rows, e.g. stress-test critiques), so untouched sections keep
 * their citations. The caller appends the freshly-emitted rows.
 */
export function carryForwardEvidence(
  prevEvidence: StoredMemoEvidence[],
  targetSet: Set<string>,
): EvidenceRow[] {
  return prevEvidence
    .filter((e) => !e.section || !targetSet.has(e.section))
    .map((e) => ({
      claimText: e.claimText,
      claimCategory: e.claimCategory,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      sourceUrl: e.sourceUrl,
      snippet: e.snippet,
      confidence: e.confidence,
      severity: e.severity,
      isCritique: e.isCritique,
      section: e.section,
    }))
}

function assembleMemo(
  companyName: string,
  roster: readonly MemoSection[],
  submitted: Map<MemoSectionHeading, { body: string; submittedAt: number }>,
): string {
  const parts: string[] = []
  parts.push(buildTitle(companyName))
  parts.push('')
  // Sort by ordinal; emit only sections that were submitted.
  for (const s of [...roster].sort((a, b) => a.ordinal - b.ordinal)) {
    const entry = submitted.get(s.heading)
    if (!entry) continue
    const cleanedBody =
      s.kind === 'synthesis' ? stripLeadingThinking(entry.body) : entry.body
    parts.push(`## ${s.heading}`)
    parts.push('')
    parts.push(cleanedBody)
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ─── Haiku transcript summarization ─────────────────────────────────────

async function summarizeTranscriptWithHaiku(
  client: Anthropic,
  m: { title: string; date: string; content: string },
): Promise<string> {
  // Cap input to avoid pathological Haiku calls on enormous transcripts.
  const truncated = m.content.length > 60_000 ? m.content.slice(0, 60_000) + '\n[...truncated]' : m.content
  const message = await client.messages.create({
    model: HAIKU_MODEL_ID,
    max_tokens: 800,
    system:
      'You are summarizing a venture-capital meeting transcript for inclusion in an investment memo workspace. Produce a 2-3 paragraph factual summary capturing: company pitch / what they do, founder details mentioned, key metrics/traction shared, terms discussed, decisions or next steps. Be specific and quote numbers verbatim. No preamble, no opinion.',
    messages: [{ role: 'user', content: `Meeting: ${m.title} (${m.date})\n\n${truncated}` }],
  })
  const block = message.content[0]
  return block?.type === 'text' ? block.text : ''
}

// ─── Section triage (which sections does the new material affect?) ───────

/**
 * Sentinel returned by `triageSectionsForNewMaterial` when triage cannot be
 * trusted (API error, malformed/empty output, or all-headings-unknown). The
 * caller surfaces a manual section-picker rather than silently guessing.
 */
export const TRIAGE_FAILED = Symbol('triage-failed')

const TRIAGE_INPUT_CHAR_CAP = 30_000

/**
 * Cheap Haiku call: given the NEW material (new call transcripts + new notes +
 * new emails) and the memo's current section headings, decide which sections
 * are materially affected and should be regenerated.
 *
 * Returns the affected headings (intersected with `existingHeadings`, with
 * "Executive Summary" always folded in since any new material shifts the
 * summary), or `TRIAGE_FAILED` on any failure so the caller can fall back to a
 * manual pick. Never silently guesses.
 */
export async function triageSectionsForNewMaterial(
  client: Anthropic,
  args: {
    existingHeadings: MemoSectionHeading[]
    newTranscripts: Array<{ title: string; date: string; content: string }>
    newNotes?: Array<{ title: string | null; content: string }>
    newEmails?: Array<{ subject: string | null; body: string }>
  },
): Promise<MemoSectionHeading[] | typeof TRIAGE_FAILED> {
  const headingSet = new Set<string>(args.existingHeadings)
  // Assemble a compact view of the new material, capped to keep this cheap.
  const blocks: string[] = []
  for (const t of args.newTranscripts) blocks.push(`Call: ${t.title} (${t.date})\n${t.content}`)
  for (const n of args.newNotes ?? []) blocks.push(`Note${n.title ? `: ${n.title}` : ''}\n${n.content}`)
  for (const e of args.newEmails ?? []) blocks.push(`Email: ${e.subject ?? '(no subject)'}\n${e.body}`)
  const material = blocks.join('\n\n---\n\n').slice(0, TRIAGE_INPUT_CHAR_CAP)

  let text: string
  try {
    const message = await client.messages.create({
      model: HAIKU_MODEL_ID,
      max_tokens: 300,
      system:
        'You decide which sections of an existing investment memo need updating given NEW material (a call, notes, or emails). ' +
        'Respond with ONLY a JSON array of section heading strings drawn verbatim from the provided list — no prose, no markdown fences. ' +
        'Include a heading only if the new material materially changes that section. If unsure, include it.',
      messages: [
        {
          role: 'user',
          content:
            `Memo sections (choose from these exact strings):\n${args.existingHeadings.map((h) => `- ${h}`).join('\n')}\n\n` +
            `New material:\n${material}\n\n` +
            `Which sections need updating? JSON array only.`,
        },
      ],
    })
    const block = message.content[0]
    text = block?.type === 'text' ? block.text : ''
  } catch (err) {
    // APIError (timeout / network / 429 / refusal) — do not guess.
    console.warn('[memo-incorporate] triage call failed:', (err as Error).message)
    return TRIAGE_FAILED
  }

  // Parse a JSON array, tolerating accidental code fences / surrounding prose.
  let parsed: unknown
  try {
    const match = text.match(/\[[\s\S]*\]/)
    parsed = JSON.parse(match ? match[0] : text)
  } catch {
    console.warn('[memo-incorporate] triage output was not parseable JSON:', text.slice(0, 200))
    return TRIAGE_FAILED
  }
  if (!Array.isArray(parsed)) return TRIAGE_FAILED

  const picked = parsed
    .filter((h): h is string => typeof h === 'string')
    .filter((h) => headingSet.has(h)) as MemoSectionHeading[]

  // All-unknown / empty → fail loud so the user picks manually.
  if (picked.length === 0) return TRIAGE_FAILED

  // Always include Executive Summary — any new material shifts the summary.
  const result = new Set<MemoSectionHeading>(picked)
  if (headingSet.has('Executive Summary')) result.add('Executive Summary')
  return [...result]
}

/**
 * IPC-facing convenience: resolves the memo/Claude API key (same precedence as
 * the producer agent) and runs section triage. Returns `TRIAGE_FAILED` when no
 * key is configured so the caller falls back to a manual section pick.
 */
export async function triageNewMaterial(args: {
  existingHeadings: MemoSectionHeading[]
  newTranscripts: Array<{ title: string; date: string; content: string }>
  newNotes?: Array<{ title: string | null; content: string }>
  newEmails?: Array<{ subject: string | null; body: string }>
}): Promise<MemoSectionHeading[] | typeof TRIAGE_FAILED> {
  const apiKey = getCredential('memoApiKey') || getCredential('claudeApiKey')
  if (!apiKey) return TRIAGE_FAILED
  return triageSectionsForNewMaterial(new Anthropic({ apiKey }), args)
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function emptyResult(errorClass: string, errorMessage: string): RunMemoProducerResult {
  return {
    status: 'failed',
    iterations: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheReadTokensTotal: 0,
    cacheCreateTokensTotal: 0,
    costEstimateUsd: 0,
    toolCallCount: 0,
    webSearchCount: 0,
    durationMs: 0,
    errorClass,
    errorMessage,
    evidenceRows: [],
    sectionsSubmitted: [],
    sectionsMissing: [],
    resultVersionId: null,
    meta: {
      contextTokensEstimated: 0,
      transcriptsKept: 0,
      transcriptsDisplaced: 0,
      summaryCacheHits: 0,
      summaryCacheMisses: 0,
      externalResearchQueryCount: 0,
      externalResearchResultCount: 0,
      evidenceRowCount: 0,
    },
  }
}
