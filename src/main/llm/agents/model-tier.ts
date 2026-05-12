import { getSetting } from '../../database/repositories/settings.repo'

/**
 * Agent model tier + cache TTL resolvers.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Both the memo producer agent and the thesis stress-test agent  │
 *   │  call getAgentModelId() and getCacheTtl() at run-start.          │
 *   │                                                                   │
 *   │  Model tier (agent.modelTier):                                    │
 *   │    • "sonnet" (default; unset → here too) → Sonnet 4.5            │
 *   │    • "haiku"                                → Haiku 4.5            │
 *   │  Lets us cut cost ~3-4× during plumbing tests at the expense of   │
 *   │  memo quality. Flip back to Sonnet for production runs.           │
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

const MODEL_TIER_KEY = 'agent.modelTier'
const CACHE_TTL_KEY = 'agent.cacheTtl'

/**
 * Beta header required to pass `ttl: '1h'` on cache_control blocks. Agents
 * include this in their Anthropic client's defaultHeaders when cacheTtl='1h'.
 */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

export function getAgentModelId(): string {
  const raw = getSetting(MODEL_TIER_KEY)
  if (!raw) return SONNET_MODEL_ID
  if (raw === 'haiku') return HAIKU_MODEL_ID
  if (raw === 'sonnet') return SONNET_MODEL_ID
  console.warn(`[model-tier] unknown agent.modelTier value "${raw}"; falling back to sonnet`)
  return SONNET_MODEL_ID
}

export function getCacheTtl(): CacheTtl {
  const raw = getSetting(CACHE_TTL_KEY)
  if (raw === '1h') return '1h'
  if (raw === '5m' || !raw) return '5m'
  console.warn(`[model-tier] unknown agent.cacheTtl value "${raw}"; falling back to 5m`)
  return '5m'
}
