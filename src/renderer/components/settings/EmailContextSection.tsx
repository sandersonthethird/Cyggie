import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

/**
 * Number input driving the `emailThreadsPerCompany` user preference (Part E) —
 * how many email threads per company/contact the in-app AI chat includes as
 * context. Stored in user_preferences (synced to Neon, so mobile/web honor it
 * too) via USER_PREF_SET, which emits the change to the sync outbox.
 *
 * Read at chat-build time by resolveEmailCap() (clamps to [1,100]); the value
 * here mirrors that clamp so the UI never shows an out-of-range number.
 */
const PREF_KEY = 'emailThreadsPerCompany' // keep in sync with EMAIL_THREADS_PREF_KEY
const DEFAULT = 20
const MIN = 1
const MAX = 100

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT
  return Math.max(MIN, Math.min(MAX, Math.trunc(n)))
}

export function EmailContextSection() {
  const [value, setValue] = useState<number>(DEFAULT)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.USER_PREF_GET_ALL)
      if (cancelled) return
      const raw = all[PREF_KEY]
      setValue(clamp(raw != null ? parseInt(raw, 10) : DEFAULT))
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  async function commit(next: number) {
    const clamped = clamp(next)
    setValue(clamped)
    await api.invoke(IPC_CHANNELS.USER_PREF_SET, PREF_KEY, String(clamped))
  }

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ minWidth: 180, fontSize: 13 }}>Emails per company in chat</span>
        <input
          type="number"
          min={MIN}
          max={MAX}
          value={value}
          onChange={(e) => setValue(clamp(parseInt(e.target.value, 10)))}
          onBlur={(e) => void commit(parseInt(e.target.value, 10))}
          style={{ width: 80, fontSize: 13 }}
        />
      </label>
      <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
        How many recent email threads per company/contact the AI chat includes as context (1–100).
        Synced across desktop and mobile.
      </p>
    </div>
  )
}
