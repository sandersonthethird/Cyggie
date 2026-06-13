import { getSetting } from '@cyggie/db/sqlite/repositories/settings.repo'
import { CLAUDE_MODEL_IDS, getPricingForModel } from '@shared/constants/claude-models'
import type { AgentPricing } from '@shared/cost-estimate'

/**
 * Agent model + cache TTL resolvers.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Both the memo producer agent and the thesis stress-test agent  │
 *   │  call getAgentModelId() and getCacheTtl() at run-start.          │
 *   │                                                                   │
 *   │  Model selection — getAgentModelId() resolves in this order:      │
 *   │    1. agent.model  — full model id from the Settings dropdown,    │
 *   │                      if set AND in the CLAUDE_MODEL_IDS allow-list │
 *   │    2. agent.modelTier (legacy radio) — "haiku"→Haiku, else Sonnet │
 *   │    3. default → Sonnet 4.5                                        │
 *   │  Unknown agent.model values warn + fall through to the default.   │
 *   │  The shared dropdown drives BOTH agents (one picker, both flows). │
 *   │                                                                   │
 *   │  Cache TTL (agent.cacheTtl):                                       │
 *   │    • "5m" (default) — Anthropic ephemeral cache, 5-min TTL        │
 *   │    • "1h"           — extended-cache-ttl-2025-04-11 beta;         │
 *   │                       agents must construct their Anthropic       │
 *   │                       client with the matching beta header.       │
 *   │  Within-run iterations always benefit; cross-run benefits from 1h │
 *   │  only when re-running the same memo within an hour.               │
 *   │                                                                   │
 *   │  Reads happen once at agent-start; mid-run setting changes don't  │
 *   │  take effect until the next run.                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 */

export const SONNET_MODEL_ID = 'claude-sonnet-4-5-20250929'
export const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001'

export type ModelTier = 'sonnet' | 'haiku'
export type CacheTtl = '5m' | '1h'

/** Full model id chosen via the Settings dropdown. Preferred over the legacy tier. */
const AGENT_MODEL_KEY = 'agent.model'
/** Legacy sonnet/haiku radio. Still honored when agent.model is unset. */
const MODEL_TIER_KEY = 'agent.modelTier'
const CACHE_TTL_KEY = 'agent.cacheTtl'

/**
 * Beta header required to pass `ttl: '1h'` on cache_control blocks. Agents
 * include this in their Anthropic client's defaultHeaders when cacheTtl='1h'.
 */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

export function getAgentModelId(): string {
  // 1. Preferred: full model id from the Settings dropdown.
  const model = getSetting(AGENT_MODEL_KEY)
  if (model) {
    if (CLAUDE_MODEL_IDS.has(model)) return model
    console.warn(`[model-tier] unknown agent.model value "${model}"; falling back to default`)
    return SONNET_MODEL_ID
  }

  // 2. Legacy radio (back-compat for installs that set it before the dropdown).
  const tier = getSetting(MODEL_TIER_KEY)
  if (!tier) return SONNET_MODEL_ID
  if (tier === 'haiku') return HAIKU_MODEL_ID
  if (tier === 'sonnet') return SONNET_MODEL_ID
  console.warn(`[model-tier] unknown agent.modelTier value "${tier}"; falling back to sonnet`)
  return SONNET_MODEL_ID
}

/**
 * Per-token pricing for the resolved agent model. Pass to runAgentLoop so logged
 * run cost matches the selected model (not a hardcoded Sonnet rate).
 */
export function getAgentPricing(): AgentPricing {
  return getPricingForModel(getAgentModelId())
}

export function getCacheTtl(): CacheTtl {
  const raw = getSetting(CACHE_TTL_KEY)
  if (raw === '1h') return '1h'
  if (raw === '5m' || !raw) return '5m'
  console.warn(`[model-tier] unknown agent.cacheTtl value "${raw}"; falling back to 5m`)
  return '5m'
}
