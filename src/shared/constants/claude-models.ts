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
}

export const CLAUDE_MODEL_OPTIONS: ClaudeModelOption[] = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]

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
