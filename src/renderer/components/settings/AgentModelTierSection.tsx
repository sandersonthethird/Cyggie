import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

/**
 * Two radio groups that drive `agent.modelTier` and `agent.cacheTtl` in the
 * settings table. Read by the main process via `getAgentModelId()` and
 * `getCacheTtl()` at the start of each agent run (mid-run setting changes
 * are NOT picked up).
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Model tier (agent.modelTier):                                  │
 *   │    • "sonnet" (default) — Claude Sonnet 4.5; production quality │
 *   │    • "haiku"            — Claude Haiku 4.5; ~3-4× cheaper       │
 *   │                                                                  │
 *   │  Cache TTL (agent.cacheTtl):                                     │
 *   │    • "5m" (default) — Anthropic ephemeral cache                 │
 *   │    • "1h"           — extended-cache-ttl-2025-04-11 beta;       │
 *   │                       falls back to 5m on entitlement errors    │
 *   └────────────────────────────────────────────────────────────────┘
 */

type ModelTier = 'sonnet' | 'haiku'
type CacheTtl = '5m' | '1h'

const MODEL_TIER_KEY = 'agent.modelTier'
const CACHE_TTL_KEY = 'agent.cacheTtl'

export function AgentModelTierSection() {
  const [modelTier, setModelTier] = useState<ModelTier>('sonnet')
  const [cacheTtl, setCacheTtl] = useState<CacheTtl>('5m')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL)
      if (cancelled) return
      const tierRaw = all[MODEL_TIER_KEY]
      setModelTier(tierRaw === 'haiku' ? 'haiku' : 'sonnet')
      const ttlRaw = all[CACHE_TTL_KEY]
      setCacheTtl(ttlRaw === '1h' ? '1h' : '5m')
    }
    void load()
    return () => { cancelled = true }
  }, [])

  async function commitModelTier(value: ModelTier) {
    setModelTier(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, MODEL_TIER_KEY, value)
  }

  async function commitCacheTtl(value: CacheTtl) {
    setCacheTtl(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, CACHE_TTL_KEY, value)
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ minWidth: 180, fontSize: 13 }}>Model tier</span>
          <span style={{ display: 'flex', gap: 16, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="agent-model-tier"
                value="sonnet"
                checked={modelTier === 'sonnet'}
                onChange={() => commitModelTier('sonnet')}
              />
              Sonnet 4.5 (default)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="agent-model-tier"
                value="haiku"
                checked={modelTier === 'haiku'}
                onChange={() => commitModelTier('haiku')}
              />
              Haiku 4.5
            </label>
          </span>
        </label>
        <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
          Sonnet for production memos. Haiku is ~3–4× cheaper — useful while testing the agent flow.
        </p>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ minWidth: 180, fontSize: 13 }}>Prompt-cache TTL</span>
          <span style={{ display: 'flex', gap: 16, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="agent-cache-ttl"
                value="5m"
                checked={cacheTtl === '5m'}
                onChange={() => commitCacheTtl('5m')}
              />
              5 minutes (default)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="agent-cache-ttl"
                value="1h"
                checked={cacheTtl === '1h'}
                onChange={() => commitCacheTtl('1h')}
              />
              1 hour (beta)
            </label>
          </span>
        </label>
        <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
          Cached prefix (system prompt + tools + initial context) hits at ~0.1× input price. 1h requires Anthropic beta entitlement; falls back to 5m on errors.
        </p>
      </div>
    </div>
  )
}
