import { useEffect, useState } from 'react'
import { api } from '../../../api'
import { IPC_CHANNELS } from '../../../../shared/constants/channels'
import appIcon from '../../../assets/app-icon.png'
import styles from '../Onboarding.module.css'

interface AuthStatus {
  signedIn: boolean
  email: string | null
}

/**
 * Step 0 — identity. Triggers the real desktop auth (CYGGIE_AUTH_SIGN_IN opens
 * the system browser) and advances when CYGGIE_AUTH_STATUS_CHANGED flips to
 * signed-in. "Use locally" stays reachable DURING the pending state so a user
 * whose callback never returns is never stuck (Lock 4).
 */
export function SignInStep({
  onSignedIn,
  onUseLocal,
}: {
  onSignedIn: (email: string | null) => void
  onUseLocal: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // If already signed in (re-entering the flow), reflect it but don't auto-skip.
    void api.invoke<AuthStatus>(IPC_CHANNELS.CYGGIE_AUTH_STATUS).then((s) => {
      if (alive && s?.signedIn) {
        // leave the user in control — they pressed nothing yet
      }
    })
    const off = api.on(IPC_CHANNELS.CYGGIE_AUTH_STATUS_CHANGED, (...args: unknown[]) => {
      const s = args[0] as AuthStatus
      if (s?.signedIn) {
        setPending(false)
        onSignedIn(s.email ?? null)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [onSignedIn])

  const onSignIn = async (): Promise<void> => {
    setError(null)
    setPending(true)
    try {
      const res = await api.invoke<{ ok: boolean; error?: string }>(IPC_CHANNELS.CYGGIE_AUTH_SIGN_IN)
      if (!res?.ok) {
        setPending(false)
        setError(res?.error ?? "Couldn't start sign-in. Try again.")
      }
      // success path resolves asynchronously via STATUS_CHANGED above.
    } catch {
      setPending(false)
      setError("Couldn't start sign-in. Try again.")
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.hero}>
        <img src={appIcon} alt="Cyggie" className={styles.heroIcon} />
        <div className={styles.headBlock}>
          <h1 className={styles.heading}>Welcome to Cyggie</h1>
          <p className={styles.sub}>
            Sign in to sync your work across devices — or use Cyggie locally on this Mac.
          </p>
        </div>
      </div>

      <div className={styles.stack}>
        <button
          type="button"
          className={`${styles.primaryBtn} ${styles.googleBtn}`}
          onClick={() => void onSignIn()}
          disabled={pending}
        >
          {pending ? 'Waiting for browser…' : 'Sign in with Google'}
        </button>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="button" className={styles.skipLink} onClick={onUseLocal}>
          Use locally without an account
        </button>
      </div>
    </div>
  )
}
