import { useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import styles from './onboarding.module.css'

/** Slugify a firm name → lowercase alphanumeric + hyphens (matches the gateway). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

type ClaimResult = { ok: true; firm: { name: string } } | { ok: false; code: string; message: string }

export function CreateWorkspace({ email }: { email: string | null }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Auto-suggest the slug from the name until the user edits it (delight #3).
  const onName = (v: string): void => {
    setName(v)
    if (!slugEdited) setSlug(slugify(v))
  }

  const domainGuess = email?.includes('@') ? email.split('@')[1] : null

  const submit = async (): Promise<void> => {
    if (!name.trim() || !slug.trim()) return
    setBusy(true)
    setError(null)
    const r = await api.invoke<ClaimResult>(IPC_CHANNELS.CYGGIE_FIRM_CLAIM, {
      name: name.trim(),
      slug: slug.trim(),
      primaryEmailDomain: domainGuess,
    })
    if (!r.ok) {
      setError(
        r.code === 'SLUG_TAKEN' ? 'That workspace URL is taken — pick another.' : r.message,
      )
      setBusy(false)
      return
    }
    // Success: the status broadcast (firm_id now set) re-routes the gate to the app.
  }

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>Create your firm's workspace</h1>
      <p className={styles.sub}>You'll be the admin. You can invite your team next.</p>

      <label className={styles.label}>
        Firm name
        <input
          className={styles.input}
          value={name}
          autoFocus
          placeholder="Red Swan Ventures"
          onChange={(e) => onName(e.target.value)}
        />
      </label>
      <label className={styles.label}>
        Workspace URL
        <input
          className={styles.input}
          value={slug}
          placeholder="red-swan-ventures"
          onChange={(e) => {
            setSlugEdited(true)
            setSlug(slugify(e.target.value))
          }}
        />
      </label>

      <button
        className={styles.primary}
        onClick={() => void submit()}
        disabled={busy || !name.trim() || !slug.trim()}
      >
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
