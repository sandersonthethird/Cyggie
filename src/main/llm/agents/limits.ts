import * as settingsRepo from '../../database/repositories/settings.repo'

/**
 * Per-run cost / iteration caps for agent loops.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Caps live in the settings table. Defaults are tuned for the   │
 *   │  thesis stress-test agent on Sonnet 4.5:                        │
 *   │                                                                 │
 *   │    iterations    15  → roughly 8-14 typical tool turns + buffer │
 *   │    web_searches  5   → enforced by counting web_search tool      │
 *   │                       calls; agent's web_search has limited      │
 *   │                       budget by design                           │
 *   │    input_tokens  400_000  → ~$1.20 typical / $1.65 worst case    │
 *   │                                                                 │
 *   │  Settings UI exposes all three; users can dial up for deep      │
 *   │  dives or down for cost-sensitive runs. Values are clamped       │
 *   │  here to safety bounds so a misconfigured value can't blow up    │
 *   │  cost or hang the loop indefinitely.                             │
 *   └────────────────────────────────────────────────────────────────┘
 */

export interface AgentLimits {
  iterations: number
  webSearches: number
  inputTokens: number
}

const DEFAULTS: AgentLimits = {
  iterations: 15,
  webSearches: 5,
  inputTokens: 400_000,
}

const BOUNDS = {
  iterations:   { min: 3,    max: 50 },
  webSearches:  { min: 0,    max: 20 },
  inputTokens:  { min: 50_000, max: 2_000_000 },
}

const SETTINGS_KEYS = {
  iterations:  'agent.maxIterations',
  webSearches: 'agent.maxWebSearches',
  inputTokens: 'agent.maxInputTokens',
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

function readNumberSetting(key: string, fallback: number): number {
  const raw = settingsRepo.getSetting(key)
  if (raw == null) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Resolve the current effective limits, reading user-set values from
 * `settings` and falling back + clamping to safety bounds.
 *
 * Read once at agent run start. Mid-run setting changes are NOT picked up;
 * the loop uses whatever values were resolved at start. Documented at the
 * caller.
 */
export function getAgentLimits(): AgentLimits {
  return {
    iterations: clamp(
      readNumberSetting(SETTINGS_KEYS.iterations, DEFAULTS.iterations),
      BOUNDS.iterations.min,
      BOUNDS.iterations.max,
    ),
    webSearches: clamp(
      readNumberSetting(SETTINGS_KEYS.webSearches, DEFAULTS.webSearches),
      BOUNDS.webSearches.min,
      BOUNDS.webSearches.max,
    ),
    inputTokens: clamp(
      readNumberSetting(SETTINGS_KEYS.inputTokens, DEFAULTS.inputTokens),
      BOUNDS.inputTokens.min,
      BOUNDS.inputTokens.max,
    ),
  }
}

export const AGENT_LIMITS_DEFAULTS = DEFAULTS
export const AGENT_LIMITS_BOUNDS = BOUNDS
export const AGENT_LIMITS_SETTINGS_KEYS = SETTINGS_KEYS
