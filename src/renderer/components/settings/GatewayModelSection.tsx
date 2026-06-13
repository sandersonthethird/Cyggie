import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { CLAUDE_MODEL_OPTIONS } from '../../../shared/constants/claude-models'

/**
 * Model pickers for the two gateway-resolved AI flows:
 *   • chatModel        — the in-app "Cyggie Ask" chat (api-gateway chat-agent)
 *   • enhancementModel — meeting enhancement (api-gateway meetings/:id/enhance)
 *
 * Stored in user_preferences (NOT the local settings table) so they sync to Neon
 * and the gateway can read them per user via resolveUserModel(). The gateway
 * falls back to its own default when a row is absent. Synced across devices.
 */
const CHAT_MODEL_PREF_KEY = 'chatModel'
const ENHANCEMENT_MODEL_PREF_KEY = 'enhancementModel'
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

const FIELDS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: CHAT_MODEL_PREF_KEY,
    label: 'In-app chat',
    hint: 'Model for "Cyggie Ask" chat on desktop and mobile.',
  },
  {
    key: ENHANCEMENT_MODEL_PREF_KEY,
    label: 'Meeting enhancement',
    hint: 'Model that turns a transcript into a structured summary.',
  },
]

export function GatewayModelSection() {
  const [values, setValues] = useState<Record<string, string>>({
    [CHAT_MODEL_PREF_KEY]: DEFAULT_MODEL,
    [ENHANCEMENT_MODEL_PREF_KEY]: DEFAULT_MODEL,
  })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.USER_PREF_GET_ALL)
      if (cancelled) return
      setValues({
        [CHAT_MODEL_PREF_KEY]: all[CHAT_MODEL_PREF_KEY] || DEFAULT_MODEL,
        [ENHANCEMENT_MODEL_PREF_KEY]: all[ENHANCEMENT_MODEL_PREF_KEY] || DEFAULT_MODEL,
      })
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  async function commit(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
    await api.invoke(IPC_CHANNELS.USER_PREF_SET, key, value)
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ minWidth: 180, fontSize: 13 }}>{f.label}</span>
            <select
              value={values[f.key]}
              onChange={(e) => void commit(f.key, e.target.value)}
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
            {f.hint} Synced across devices.
          </p>
        </div>
      ))}
    </div>
  )
}
