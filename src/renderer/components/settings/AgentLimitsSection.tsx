import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'

/**
 * Three numeric inputs that drive `agent.maxIterations`, `agent.maxWebSearches`,
 * `agent.maxInputTokens` in the settings table. Read by the main process via
 * `getAgentLimits()` at the start of each agent run (mid-run setting changes
 * are NOT picked up — values are resolved at the start of each run).
 *
 * Bounds match the limits.ts safety clamps; values outside the bounds are
 * silently clamped at runtime, so the inputs reflect user intent even if
 * out of bounds.
 */

interface FieldSpec {
  key: string
  label: string
  defaultValue: number
  hint: string
  step?: number
}

const FIELDS: FieldSpec[] = [
  {
    key: 'agent.maxIterations',
    label: 'Max iterations',
    defaultValue: 15,
    hint: 'How many tool-use turns the agent can run. Default 15. Bounds: 3–50.',
  },
  {
    key: 'agent.maxWebSearches',
    label: 'Max web searches',
    defaultValue: 5,
    hint: 'How many web_search calls the agent can make per run. Default 5. Bounds: 0–20.',
  },
  {
    key: 'agent.maxInputTokens',
    label: 'Max input tokens',
    defaultValue: 400_000,
    hint: 'Cumulative input-token budget per run. Default 400k. Bounds: 50k–2M.',
    step: 50_000,
  },
]

export function AgentLimitsSection() {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map(f => [f.key, String(f.defaultValue)])),
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      const all = await api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL)
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const f of FIELDS) {
        next[f.key] = all[f.key] ?? String(f.defaultValue)
      }
      setValues(next)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  async function commit(key: string, raw: string) {
    setValues(prev => ({ ...prev, [key]: raw }))
    const trimmed = raw.trim()
    await api.invoke(IPC_CHANNELS.SETTINGS_SET, key, trimmed)
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {FIELDS.map(field => (
        <div key={field.key}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ minWidth: 180, fontSize: 13 }}>{field.label}</span>
            <input
              type="number"
              value={values[field.key] ?? ''}
              step={field.step ?? 1}
              onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
              onBlur={e => commit(field.key, e.target.value)}
              style={{
                width: 140,
                padding: '4px 8px',
                fontSize: 13,
                border: '1px solid var(--color-border, #e5e7eb)',
                borderRadius: 4,
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          </label>
          <p style={{ marginLeft: 192, marginTop: 2, fontSize: 11, color: 'var(--color-text-secondary, #6b7280)' }}>
            {field.hint}
          </p>
        </div>
      ))}
    </div>
  )
}
