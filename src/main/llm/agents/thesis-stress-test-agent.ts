/**
 * Thesis Stress-Test Agent.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Wraps runAgentLoop with the thesis-stress-test system prompt   │
 *   │  and tool registry. Adds the post-`submit_memo` scope-lock       │
 *   │  validation: descriptive sections (Business, Market, Team, GTM,  │
 *   │  References) must be byte-identical to the input memo.          │
 *   │                                                                 │
 *   │  Caller flow (IPC handler):                                      │
 *   │    1. await runStressTestAgent({...})                            │
 *   │    2. on success → persist new InvestmentMemoVersion + evidence │
 *   │       rows in one transaction                                    │
 *   │    3. emit AgentEvent {type: 'done', versionId}                  │
 *   └────────────────────────────────────────────────────────────────┘
 */

import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoop, type AgentRunResult } from './agent-loop'
import { THESIS_STRESS_TEST_TOOLS } from './thesis-tools'
import { getAgentLimits, type AgentLimits } from './limits'
import { SubmitMemoInputSchema, type SubmitMemoInput } from '../../../shared/types/thesis'
import type { AgentEvent } from '../../../shared/types/agent-events'
import { getCredential } from '../../security/credentials'
import { stressTestPassthrough, stressTestTargets } from '../memo/sections'
import { getAgentModelId, getCacheTtl, EXTENDED_CACHE_TTL_BETA } from './model-tier'
// Vite ?raw inlines the markdown content as a string at build time.
import THESIS_SYSTEM_PROMPT from './prompts/thesis-stress-test.system.md?raw'

/**
 * Section axes for the stress-test agent's scope-lock validator. Derived
 * from MEMO_SECTIONS so a rename or section-roster change in one place
 * propagates here automatically.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  TARGET sections (agent MAY rewrite): synthesis-kind + a few    │
 *   │     research/narrative conclusory ones (Competition, Traction,  │
 *   │     Valuation). Plus Devil's Advocate, which is appended to    │
 *   │     the output and has no input counterpart.                    │
 *   │  PASSTHROUGH (agent must NOT modify; byte-identical required): │
 *   │     everything else in the roster.                              │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * If you rename a section, only MEMO_SECTIONS needs updating; both the
 * arrays below and the system prompt's heading list rebuild from it.
 */
const TARGET_SECTION_HEADINGS = [
  ...stressTestTargets(),
  "Devil's Advocate",           // appended; not in input
] as const

const PASSTHROUGH_SECTION_HEADINGS = stressTestPassthrough() as readonly string[]

export interface RunStressTestAgentInput {
  runId: string
  companyId: string
  companyName: string
  userId: string
  existingMemoMarkdown: string
  /** AbortSignal for the IPC handler — caller controls cancellation. */
  signal: AbortSignal
  /** Per-event sink. The IPC handler routes these to renderer + run-store. */
  emit: (event: AgentEvent) => void
  /** Optional override for tests / cost-tuning; defaults to settings-backed. */
  limits?: AgentLimits
}

export interface RunStressTestAgentResult extends AgentRunResult {
  /** When status==='success', the validated submit_memo input. */
  submitInput?: SubmitMemoInput
  /** When status==='success', any scope-lock warning the validator surfaced. */
  scopeLockWarnings: string[]
}

export async function runStressTestAgent(
  input: RunStressTestAgentInput,
): Promise<RunStressTestAgentResult> {
  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) {
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
      errorClass: 'AuthenticationError',
      errorMessage: 'Claude API key not configured',
      scopeLockWarnings: [],
    }
  }

  const model = getAgentModelId()
  const cacheTtl = getCacheTtl()
  const client = new Anthropic({
    apiKey,
    ...(cacheTtl === '1h'
      ? { defaultHeaders: { 'anthropic-beta': EXTENDED_CACHE_TTL_BETA } }
      : {}),
  })
  const limits = input.limits ?? getAgentLimits()

  const initialUserMessage =
    `Stress-test the existing investment memo for "${input.companyName}".\n\n` +
    `MODE: stress_test (review decisions #23-#25 enforce scope).\n\n` +
    `Read the existing memo first via \`read_existing_memo\`. Then research as needed via the internal-data and web tools. ` +
    `When ready, call \`submit_memo\` with the FULL revised memo plus structured evidence.`

  const result = await runAgentLoop({
    client,
    model,
    systemPrompt: THESIS_SYSTEM_PROMPT,
    initialUserMessage,
    tools: THESIS_STRESS_TEST_TOOLS,
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
    kind: 'thesis_stress_test',
    mode: 'stress_test',
    companyId: input.companyId,
    cacheTtl,
  })

  if (result.status !== 'success' || !result.terminalToolInput) {
    return { ...result, scopeLockWarnings: [] }
  }

  // Re-validate the terminal input via Zod (paranoia: agent-loop already did,
  // but the IPC handler is about to write to the DB and we want a typed
  // shape on the way out).
  const parsed = SubmitMemoInputSchema.safeParse(result.terminalToolInput)
  if (!parsed.success) {
    return {
      ...result,
      status: 'failed',
      errorClass: 'TerminalValidation',
      errorMessage: parsed.error.message,
      scopeLockWarnings: [],
    }
  }

  // Scope-lock check: the descriptive sections in the new memo must be
  // byte-identical to the corresponding sections in the input memo.
  const warnings = scopeLockCheck(input.existingMemoMarkdown, parsed.data.markdown)

  return {
    ...result,
    submitInput: parsed.data,
    scopeLockWarnings: warnings,
  }
}

// ─── Scope-lock validation ────────────────────────────────────────────────

interface ParsedSection {
  heading: string
  body: string
}

/**
 * Parse a memo's top-level `##`-prefixed sections (we don't recurse into `###`
 * subsections; the section structure is flat by spec). Returns one
 * ParsedSection per heading. The opening title (`# {Company}…`) is treated
 * as a special pre-section and ignored here.
 */
function parseSections(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n')
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/)
    if (headingMatch) {
      if (current) sections.push(current)
      current = { heading: headingMatch[1], body: '' }
    } else if (current) {
      current.body += line + '\n'
    }
  }
  if (current) sections.push(current)
  return sections
}

function normalizeBody(s: string): string {
  // Trim trailing whitespace per line + collapse trailing newlines, so the
  // byte-identical check tolerates incidental whitespace differences from
  // markdown rendering. We don't normalize internal whitespace because
  // claim-bearing prose is whitespace-significant.
  return s
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

/**
 * Returns warning strings for any descriptive section that was modified.
 * The caller decides whether to fail the run, retry, or just log warnings.
 * Phase 1 logs warnings and proceeds; Phase 2 will gate save behind a clean
 * scope-lock pass.
 */
export function scopeLockCheck(input: string, output: string): string[] {
  const warnings: string[] = []
  const inputSections = new Map(parseSections(input).map(s => [s.heading, s]))
  const outputSections = new Map(parseSections(output).map(s => [s.heading, s]))

  for (const heading of PASSTHROUGH_SECTION_HEADINGS) {
    const inSec = inputSections.get(heading)
    const outSec = outputSections.get(heading)
    if (!inSec) continue                               // wasn't in the input → nothing to check
    if (!outSec) {
      warnings.push(`scope-lock: pass-through section "${heading}" missing from output`)
      continue
    }
    if (normalizeBody(inSec.body) !== normalizeBody(outSec.body)) {
      warnings.push(`scope-lock: pass-through section "${heading}" was modified`)
    }
  }

  // Devil's Advocate must appear in the output (it's the agent's required appendix).
  if (!outputSections.has('Devil\'s Advocate') && !outputSections.has("Devil's Advocate")) {
    warnings.push("scope-lock: required '## Devil's Advocate' section missing from output")
  }

  return warnings
}

export const STRESS_TEST_TARGET_SECTIONS = TARGET_SECTION_HEADINGS
export const STRESS_TEST_PASSTHROUGH_SECTIONS = PASSTHROUGH_SECTION_HEADINGS
