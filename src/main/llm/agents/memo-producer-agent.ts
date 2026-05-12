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
import { getCredential } from '../../security/credentials'
import { getSetting } from '../../database/repositories/settings.repo'
import type { AgentEvent } from '../../../shared/types/agent-events'
import type { EvidenceRow } from '../../../shared/types/thesis'
import {
  MEMO_SECTIONS,
  type MemoSection,
  type MemoSectionHeading,
  isSeriesAOrLater,
  canonicalizeUrl,
} from '../memo/sections'
import { allocateContext, type MeetingTranscriptInput, ContextOverflowError } from '../memo/context-budget'
import { persistMemoArtifacts } from '../memo/persist'
import { searchCompanyContext, type ExternalResearchBundle } from '../../services/exa-research'
// Vite ?raw inlines the markdown content as a string at build time.
import MEMO_PRODUCER_SYSTEM_PROMPT_TEMPLATE from './prompts/memo-producer.system.md?raw'

import * as companyRepo from '../../database/repositories/org-company.repo'
import * as memoRepo from '../../database/repositories/investment-memo.repo'
import * as meetingRepo from '../../database/repositories/meeting.repo'
import { getFlaggedFiles } from '../../database/repositories/company-file-flags.repo'
import { makeEntityNotesRepo } from '../../database/repositories/notes-base'
import { readSummary, readTranscript } from '../../storage/file-manager'

const MODEL_ID = 'claude-sonnet-4-5-20250929'
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001'
const SETTING_EXTENDED_THINKING = 'agent.memoProducerExtendedThinking'
const _companyNotesRepo = makeEntityNotesRepo('company_id')

/** Below this section count, we don't persist anything. */
export const MIN_SECTIONS_TO_PERSIST = 3

export interface RunMemoProducerInput {
  runId: string
  companyId: string
  memoId: string
  userId: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  limits?: AgentLimits
  /**
   * Optional: filter roster to a single heading. Used by the per-section
   * "Refresh this section" feature. When set, the run produces just this one
   * section's body and skips all others. `MIN_SECTIONS_TO_PERSIST` is
   * effectively 1 in this mode.
   */
  refreshSectionOnly?: MemoSectionHeading
}

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
  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) {
    return emptyResult('AuthenticationError', 'Claude API key not configured')
  }
  const client = new Anthropic({ apiKey })
  const limits = input.limits ?? getAgentLimits()
  const extendedThinkingEnabled = getSetting(SETTING_EXTENDED_THINKING) !== 'false' // default true

  // ─── Gather company + data ────────────────────────────────────────────
  const company = companyRepo.getCompany(input.companyId)
  if (!company) {
    return emptyResult('CompanyNotFound', `company not found: ${input.companyId}`)
  }

  const meetingsRaw = companyRepo.listCompanyMeetings(input.companyId)
  const summaryPaths = companyRepo.listCompanyMeetingSummaryPaths(input.companyId)
  const summaryByMeetingId = new Map(summaryPaths.map((s) => [s.meetingId, s.summaryPath]))
  const meetingsWithSummary = new Set(summaryByMeetingId.keys())

  // Producer agent sees FULL transcripts for every meeting that has one.
  // Context budget will displace older transcripts to summarized form if the
  // total blows past 180k tokens.
  const transcriptInputs: MeetingTranscriptInput[] = []
  for (const m of meetingsRaw) {
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

  // Existing memo, if any.
  const existingVersion = memoRepo.getMemoLatestVersion(input.memoId)
  const existingMemoMarkdown = existingVersion?.contentMarkdown ?? ''

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
  let externalResearch: ExternalResearchBundle = { queries: [], results: [] }
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

  // ─── Filter section roster by gates ───────────────────────────────────
  const seriesAPlus = isSeriesAOrLater(company.stage)
  const hasReferenceCalls = /reference call|reference\s+(check|conversation)/i.test(
    summariesByDateDesc.map((s) => s.title).join(' '),
  )
  const fullRoster = MEMO_SECTIONS.filter((s) => {
    if (input.refreshSectionOnly) return s.heading === input.refreshSectionOnly
    if (s.gate === 'series_a_plus') return seriesAPlus
    if (s.gate === 'has_reference_calls') return hasReferenceCalls
    return true
  })
  const sectionRoster: readonly MemoSection[] = fullRoster

  // ─── Allocate context (token-counted; may displace transcripts) ──────
  // Scaffold = company overview + notes + contact profiles + file refs +
  // existing memo + external research, all in one string used both for token
  // counting and the agent's initial user message.
  const scaffold = buildScaffold({
    company,
    notes: notes.filter((n) => n.content?.trim()),
    contacts: linkedContacts,
    files: flagged,
    existingMemoMarkdown,
    externalResearch,
  })

  let allocated
  try {
    allocated = await allocateContext({
      anthropic: client,
      model: MODEL_ID,
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

  // Inject section roster into system prompt.
  const rosterBlock = sectionRoster
    .map((s) => `${s.ordinal}. **${s.heading}** (${s.kind}${s.required ? ', required' : ', optional'})`)
    .join('\n')
  const systemPrompt = MEMO_PRODUCER_SYSTEM_PROMPT_TEMPLATE.replace('###SECTION_ROSTER###', rosterBlock)

  // Build initial user message: scaffold + raw transcripts + summarized older ones.
  const initialUserMessage = buildInitialUserMessage({
    scaffold,
    rawTranscripts: allocated.rawTranscripts,
    summarizedTranscripts: allocated.summarizedTranscripts,
    refreshSectionOnly: input.refreshSectionOnly,
  })

  // ─── Run agent loop ────────────────────────────────────────────────────
  const tools = buildMemoProducerTools(state)
  const result = await runAgentLoop({
    client,
    model: MODEL_ID,
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

  const minRequired = input.refreshSectionOnly ? 1 : MIN_SECTIONS_TO_PERSIST
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

  const assembled = assembleMemo(company.canonicalName, sectionRoster, state.submittedSections)

  // ─── Persist (transactionally) ────────────────────────────────────────
  let resultVersionId: string | null = null
  try {
    const persisted = persistMemoArtifacts({
      memoId: input.memoId,
      contentMarkdown: assembled,
      changeNote: input.refreshSectionOnly
        ? `Refreshed section: ${input.refreshSectionOnly}`
        : 'Generated by producer agent',
      userId: input.userId,
      evidenceRows: state.evidenceBuffer,
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

  if (args.existingMemoMarkdown.trim()) {
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
  refreshSectionOnly?: MemoSectionHeading
}): string {
  const parts: string[] = []
  parts.push(args.scaffold)

  if (args.rawTranscripts.length > 0) {
    parts.push('\n---\n## Meeting Transcripts (full text)\n')
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

  if (args.refreshSectionOnly) {
    parts.push(
      `\n---\nMODE: refresh-single-section\n` +
        `Produce ONLY the "${args.refreshSectionOnly}" section, then call done({}). ` +
        `Other sections in the roster have already been generated and persisted; ` +
        `do not regenerate them.`,
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

// ─── Helpers ─────────────────────────────────────────────────────────────

function emptyResult(errorClass: string, errorMessage: string): RunMemoProducerResult {
  return {
    status: 'failed',
    iterations: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
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
