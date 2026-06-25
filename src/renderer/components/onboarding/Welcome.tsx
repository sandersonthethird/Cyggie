import { useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import styles from './onboarding.module.css'

export function Welcome({ onUseLocal }: { onUseLocal: () => void }) {
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // If sign-in stalls (user cancels in the browser), re-arm the button.
  useEffect(() => {
    if (!signingIn) return
    const t = setTimeout(() => setSigningIn(false), 60_000)
    return () => clearTimeout(t)
  }, [signingIn])

  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setError(null)
    const r = await api.invoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.CYGGIE_AUTH_SIGN_IN)
    if (!r.ok) {
      setError("Couldn't start sign-in. Check your connection and try again.")
      setSigningIn(false)
    }
    // On success the system browser opens; the gate re-routes when the
    // CYGGIE_AUTH_STATUS_CHANGED broadcast arrives after the callback.
  }

  return (
    <div className={styles.card}>
      <h1 className={styles.brand}>Cyggie</h1>
      <p className={styles.lede}>
        Sign in to sync your firm's notes, meetings, and contacts across your devices.
      </p>
      <button className={styles.primary} onClick={() => void signIn()} disabled={signingIn}>
        {signingIn ? 'Opening browser…' : 'Sign in with Google'}
      </button>
      {error && <p className={styles.error}>{error}</p>}
      <button className={styles.linkBtn} onClick={onUseLocal}>
        Use locally without an account
      </button>
    </div>
  )
}
