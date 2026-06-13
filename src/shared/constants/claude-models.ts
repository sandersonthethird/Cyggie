/**
 * Single source of truth for the selectable Claude models surfaced in Settings.
 *
 * Consumed by:
 *   • renderer Settings UI (Settings.tsx, AgentModelTierSection.tsx) — dropdowns
 *   • packages/services model resolver (agents/model-tier.ts) — validation
 *
 * Add a model here once and every picker + the resolver's allow-list pick it up.
 * Keep the first entry's value as the production default referenced elsewhere.
 */

export interface ClaudeModelOption {
  value: string
  label: string
  /** USD per 1M input tokens. List price at the model's release; edit when prices change. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
}

export const CLAUDE_MODEL_OPTIONS: ClaudeModelOption[] = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', inputPerM: 15, outputPerM: 75 },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', inputPerM: 3, outputPerM: 15 },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', inputPerM: 3, outputPerM: 15 },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', inputPerM: 1, outputPerM: 5 },
]

/** Default agent model when nothing is persisted — Sonnet 4.5 (matches getAgentModelId). */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-5-20250929'

export interface ModelPricing {
  inputPerM: number
  outputPerM: number
}

/** Per-model pricing, keyed by model id. Derived from CLAUDE_MODEL_OPTIONS so a model and its price are added in one place. */
export const CLAUDE_MODEL_PRICING: Record<string, ModelPricing> = Object.fromEntries(
  CLAUDE_MODEL_OPTIONS.map((o) => [o.value, { inputPerM: o.inputPerM, outputPerM: o.outputPerM }]),
)

/** Pricing for a (possibly unknown) model id. Unknown/garbage → the default model's pricing. */
export function getPricingForModel(modelId: string | null | undefined): ModelPricing {
  return (modelId && CLAUDE_MODEL_PRICING[modelId]) || CLAUDE_MODEL_PRICING[DEFAULT_AGENT_MODEL]
}

/**
 * Resolve the effective agent model id from a settings map, mirroring
 * getAgentModelId()'s precedence: full `agent.model` (if allow-listed) →
 * legacy `agent.modelTier` radio → default. Pure, so renderer pickers and the
 * cost estimate resolve identically.
 */
export function resolveAgentModelId(all: Record<string, string | undefined>): string {
  const model = all['agent.model']
  if (model && CLAUDE_MODEL_IDS.has(model)) return model
  if (all['agent.modelTier'] === 'haiku') return 'claude-haiku-4-5-20251001'
  return DEFAULT_AGENT_MODEL
}

export const CLAUDE_MODEL_LABELS: Record<string, string> = Object.fromEntries(
  CLAUDE_MODEL_OPTIONS.map((o) => [o.value, o.label]),
)

/** Allow-list of valid model IDs, for validating persisted setting values. */
export const CLAUDE_MODEL_IDS: ReadonlySet<string> = new Set(
  CLAUDE_MODEL_OPTIONS.map((o) => o.value),
)

export function isKnownClaudeModel(id: string | null | undefined): id is string {
  return !!id && CLAUDE_MODEL_IDS.has(id)
}
