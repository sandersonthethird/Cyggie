import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { CLAUDE_MODEL_OPTIONS, CLAUDE_MODEL_IDS } from '../../../shared/constants/claude-models'

/**
 * A model dropdown + a cache-TTL radio group that drive `agent.model` and
 * `agent.cacheTtl` in the settings table. Read by the main process via
 * `getAgentModelId()` and `getCacheTtl()` at the start of each agent run
 * (mid-run setting changes are NOT picked up).
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Memo & stress-test model (agent.model):                       │
 *   │    • one full model id from CLAUDE_MODEL_OPTIONS                │
 *   │    • default Sonnet 4.5; drives BOTH the memo producer and the  │
 *   │      thesis stress-test agents (one shared picker)              │
 *   │    • legacy agent.modelTier (sonnet/haiku radio) is still read  │
 *   │      by getAgentModelId() when agent.model is unset             │
 *   │                                                                  │
 *   │  Cache TTL (agent.cacheTtl):                                     │
 *   │    • "5m" (default) — Anthropic ephemeral cache                 │
 *   │    • "1h"           — extended-cache-ttl-2025-04-11 beta;       │
 *   │                       falls back to 5m on entitlement errors    │
 *   └────────────────────────────────────────────────────────────────┘
 */

type CacheTtl = '5m' | '1h'

const AGENT_MODEL_KEY = 'agent.model'
const MODEL_TIER_KEY = 'agent.modelTier'
const CACHE_TTL_KEY = 'agent.cacheTtl'

const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-5-20250929'

/** Mirror getAgentModelId()'s legacy fallback so the UI shows the resolved value. */
function resolveInitialModel(all: Record<string, string>): string {
  const model = all[AGENT_MODEL_KEY]
  if (model && CLAUDE_MODEL_IDS.has(model)) return model
  const tier = all[MODEL_TIER_KEY]
  if (tier === 'haiku') return 'claude-haiku-4-5-20251001'
  return DEFAULT_AGENT_MODEL
}

export function AgentModelTierSection() {
  const [model, setModel] = useState<string>(DEFAULT_AGENT_MODEL)
  const [cacheTtl, setCacheTtl] = useState<CacheTtl>('5m')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL)
      if (cancelled) return
      setModel(resolveInitialModel(all))
      const ttlRaw = all[CACHE_TTL_KEY]
      setCacheTtl(ttlRaw === '1h' ? '1h' : '5m')
    }
    void load()
    return () => { cancelled = true }
  }, [])

  async function commitModel(value: string) {
    setModel(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, AGENT_MODEL_KEY, value)
  }

  async function commitCacheTtl(value: CacheTtl) {
    setCacheTtl(value)
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, CACHE_TTL_KEY, value)
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ minWidth: 180, fontSize: 13 }}>Memo &amp; stress-test model</span>
          <select
            value={model}
            onChange={(e) => commitModel(e.target.value)}
            style={{ fontSize: 13 }}
          >
            {CLAUDE_MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
          Drives both the memo producer and the thesis stress-test agents. Sonnet for production memos; Haiku is ~3–4× cheaper for testing the agent flow.
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
