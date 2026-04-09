import { useState } from 'react'
import styles from './SocialsEditor.module.css'

interface SocialsEditorProps {
  value: string | null
  onSave: (json: string | null) => Promise<void>
}

interface SocialEntry {
  network: string
  url: string
}

const PRESET_NETWORKS = ['LinkedIn', 'Twitter/X', 'GitHub', 'Instagram', 'Facebook', 'YouTube']

const URL_TO_NETWORK: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'twitter.com': 'Twitter/X',
  'x.com': 'Twitter/X',
  'github.com': 'GitHub',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'youtube.com': 'YouTube',
}

function detectNetwork(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return URL_TO_NETWORK[host] ?? null
  } catch {
    return null
  }
}

function parseJson(raw: string | null): SocialEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed).map(([network, url]) => ({
      network,
      url: String(url)
    }))
  } catch {
    return []
  }
}

function serializeEntries(entries: SocialEntry[]): string | null {
  const valid = entries.filter((e) => e.network.trim() && e.url.trim())
  if (valid.length === 0) return null
  return JSON.stringify(Object.fromEntries(valid.map((e) => [e.network.trim(), e.url.trim()])))
}

export function SocialsEditor({ value, onSave }: SocialsEditorProps) {
  const [entries, setEntries] = useState<SocialEntry[]>(() => parseJson(value))
  const [saving, setSaving] = useState(false)

  async function save(next: SocialEntry[]) {
    setSaving(true)
    try {
      await onSave(serializeEntries(next))
    } catch (e) {
      console.error('[SocialsEditor] save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  function updateEntry(index: number, field: 'network' | 'url', val: string) {
    const next = entries.map((e, i) => (i === index ? { ...e, [field]: val } : e))
    setEntries(next)
  }

  // Mirrors removeEntry() pattern: construct next inline and call save(next) to avoid
  // stale React state. Must NOT call updateEntry() then save(entries).
  function handleNetworkChange(index: number, newNetwork: string) {
    const next = entries.map((e, i) =>
      i === index ? { ...e, network: newNetwork === 'Other' ? '' : newNetwork } : e
    )
    setEntries(next)
    save(next)
  }

  function handleUrlChange(index: number, val: string) {
    const entry = entries[index]
    const detectedNetwork = entry.network === '' ? detectNetwork(val) : null
    const next = entries.map((e, i) =>
      i === index
        ? { ...e, url: val, ...(detectedNetwork ? { network: detectedNetwork } : {}) }
        : e
    )
    setEntries(next)
  }

  function removeEntry(index: number) {
    const next = entries.filter((_, i) => i !== index)
    setEntries(next)
    save(next)
  }

  function addEntry() {
    setEntries([...entries, { network: '', url: '' }])
  }

  function handleBlur() {
    save(entries)
  }

  return (
    <div className={styles.root}>
      {entries.map((entry, i) => {
        const isPreset = PRESET_NETWORKS.includes(entry.network)
        const selectValue = entry.network === '' ? '' : isPreset ? entry.network : 'Other'
        const showCustomInput = selectValue === 'Other'

        return (
          <div key={i} className={styles.entry}>
            <select
              className={styles.networkSelect}
              value={selectValue}
              onChange={(e) => handleNetworkChange(i, e.target.value)}
            >
              <option value="" disabled>Network</option>
              {PRESET_NETWORKS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              <option value="Other">Other</option>
            </select>
            {showCustomInput && (
              <input
                className={styles.customNetworkInput}
                placeholder="Network name"
                value={entry.network}
                onChange={(e) => updateEntry(i, 'network', e.target.value)}
                onBlur={handleBlur}
              />
            )}
            <input
              className={styles.urlInput}
              placeholder="URL"
              value={entry.url}
              onChange={(e) => handleUrlChange(i, e.target.value)}
              onBlur={handleBlur}
            />
            <button className={styles.removeBtn} onClick={() => removeEntry(i)} title="Remove">
              ×
            </button>
          </div>
        )
      })}
      <button className={styles.addBtn} onClick={addEntry} disabled={saving}>
        + Add social
      </button>
    </div>
  )
}
