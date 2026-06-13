import { getPricingForModel } from './constants/claude-models'

/**
 * Dependency-free run-cost estimation for agent loops.
 *
 * Lives in @shared because BOTH the renderer (AgentLimitsSection live estimate)
 * and the main process (agent-loop / model-tier) need it, and it pulls in no
 * settings/DB/Electron code. Per-model pricing lives in the model registry
 * (./constants/claude-models); this module adds the run-cost math on top.
 *
 *   estimateAgentRunCostUsd — the display estimate shown in Settings:
 *
 *     estUsd = inputTokens * inputPerM / 1e6            // input budget (dominant)
 *            + iterations  * OUT_PER_ITER * outputPerM  // per-turn output
 *                          / 1e6
 *            + webSearches * WEB_SEARCH_PRICE_USD        // Anthropic web search
 *
 * Pricing (inputPerM/outputPerM) is resolved from the selected model id, so the
 * estimate tracks whatever model the Settings dropdown selects.
 */

export interface AgentPricing {
  inputPerM: number
  outputPerM: number
}

/** Anthropic web search ≈ $10 / 1,000 searches. */
export const WEB_SEARCH_PRICE_USD = 0.01

/** Rough output tokens per agent tool-use turn, for the display estimate. */
export const EST_OUTPUT_TOKENS_PER_ITERATION = 700

/** Pricing for the default agent model — used as the agent-loop fallback. */
export const DEFAULT_AGENT_PRICING: AgentPricing = getPricingForModel(undefined)

export interface AgentRunLimits {
  inputTokens: number
  iterations: number
  webSearches: number
}

/** Coerce a possibly-NaN/undefined cap to a non-negative finite number. */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Estimate the USD cost of one agent run from its caps and selected model id.
 * Guards against NaN/empty caps (a field cleared mid-edit) by treating that term
 * as 0, so the result is never NaN. Unknown model ids fall back to default pricing.
 */
export function estimateAgentRunCostUsd(limits: AgentRunLimits, modelId: string): number {
  const { inputPerM, outputPerM } = getPricingForModel(modelId)
  const inputCost = (safe(limits.inputTokens) * inputPerM) / 1_000_000
  const outputCost =
    (safe(limits.iterations) * EST_OUTPUT_TOKENS_PER_ITERATION * outputPerM) / 1_000_000
  const searchCost = safe(limits.webSearches) * WEB_SEARCH_PRICE_USD
  return inputCost + outputCost + searchCost
}
