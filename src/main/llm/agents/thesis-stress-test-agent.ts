/**
 * Thesis Stress-Test Agent.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Wraps runAgentLoop with the thesis-stress-test system prompt   │
 *   │  and tool registry. Under the new product model the agent       │
 *   │  produces a structured StressTestReport via the submit_review    │
 *   │  terminal tool. The memo is NEVER mutated by this run.           │
 *   │                                                                 │
 *   │  Caller flow (IPC handler):                                      │
 *   │    1. await runStressTestAgent({...})                            │
 *   │    2. on success → persistStressTestReport (new repo)            │
 *   │    3. emit AgentEvent {type: 'done', versionId: reportId}        │
 *   │       (agent_runs.result_version_id is reused to hold report id) │
 *   └────────────────────────────────────────────────────────────────┘
 */

import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoop, type AgentRunResult } from './agent-loop'
import { THESIS_STRESS_TEST_TOOLS } from './thesis-tools'
import { getAgentLimits, type AgentLimits } from './limits'
import { SubmitReviewInputSchema, type SubmitReviewInput } from '../../../shared/types/stress-test-report'
import type { AgentEvent } from '../../../shared/types/agent-events'
import { getCredential } from '../../security/credentials'
import { getAgentModelId, getCacheTtl, EXTENDED_CACHE_TTL_BETA } from './model-tier'
// Vite ?raw inlines the markdown content as a string at build time.
import THESIS_SYSTEM_PROMPT_TEMPLATE from './prompts/thesis-stress-test.system.md?raw'
import STRESS_TEST_CHECKLIST from './prompts/stress-test-checklist.md?raw'

/** Matches our placeholder convention `###CAPS_AND_UNDERSCORES###` — not markdown h3. */
const PLACEHOLDER_PATTERN = /###[A-Z_]+###/

/**
 * Build the thesis-stress-test system prompt by substituting placeholders.
 * Throws if any placeholder remains unsubstituted.
 */
export function buildThesisStressTestSystemPrompt(): string {
  const prompt = THESIS_SYSTEM_PROMPT_TEMPLATE
    .replace('###STRESS_TEST_CHECKLIST###', STRESS_TEST_CHECKLIST)
  const leftover = prompt.match(PLACEHOLDER_PATTERN)
  if (leftover) {
    throw new Error(`Unsubstituted prompt placeholder in thesis-stress-test system prompt: ${leftover[0]}`)
  }
  return prompt
}

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
  /** When status==='success', the validated submit_review input (typed). */
  submitInput?: SubmitReviewInput
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
    `Your job is to poke holes in the thesis. Read the existing memo first via \`read_existing_memo\`. ` +
    `Then research as needed via the internal-data and web tools. ` +
    `When ready, call \`submit_review\` with your summary, recommendation, 3–8 numbered concerns, and structured evidence.`

  const result = await runAgentLoop({
    client,
    model,
    systemPrompt: buildThesisStressTestSystemPrompt(),
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
    return { ...result }
  }

  // Re-validate the terminal input via Zod (paranoia: agent-loop already did,
  // but the IPC handler is about to write to the DB and we want a typed shape
  // on the way out).
  const parsed = SubmitReviewInputSchema.safeParse(result.terminalToolInput)
  if (!parsed.success) {
    return {
      ...result,
      status: 'failed',
      errorClass: 'TerminalValidation',
      errorMessage: parsed.error.message,
    }
  }

  return {
    ...result,
    submitInput: parsed.data,
  }
}
