import { useEffect, useState } from 'react'
import { api } from '../../../api'
import { IPC_CHANNELS } from '../../../../shared/constants/channels'
import { StepLinks } from '../StepLinks'
import styles from '../Onboarding.module.css'

/**
 * Step 2 — connect Google (calendar). One-click when client creds are already
 * configured; otherwise reveals Client ID/Secret fields inline, then connects.
 * Our calendar auth is a loopback OAuth flow that needs creds (not gateway-OAuth).
 * CALENDAR_CONNECT is wrapped so OAuth cancel/deny/missing-creds surface a named
 * error rather than an unhandled rejection (Lock 4). Always skippable.
 */
export function GoogleStep({
  connected,
  onConnected,
  onBack,
  onSkip,
}: {
  connected: boolean
  onConnected: () => void
  onBack: () => void
  onSkip: () => void
}) {
  const [credsConfigured, setCredsConfigured] = useState<boolean | null>(null)
  const [showCreds, setShowCreds] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'google_client_id').then((v) => {
      setCredsConfigured(Boolean(v && v.length > 0))
    })
  }, [])

  const connect = async (): Promise<void> => {
    // No creds saved yet → reveal the fields first; require them before connecting.
    if (credsConfigured === false && !showCreds) {
      setShowCreds(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.invoke<{ connected: boolean }>(
        IPC_CHANNELS.CALENDAR_CONNECT,
        clientId.trim(),
        clientSecret.trim(),
      )
      if (res?.connected) {
        onConnected()
      } else {
        setError("Couldn't connect — try again.")
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        /client id/i.test(msg)
          ? 'Add your Google Client ID & secret below, then connect.'
          : "Couldn't connect — check the credentials and try again.",
      )
      setShowCreds(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Connect Google</h1>
        <p className={styles.sub}>
          Cyggie reads your calendar to build your firm’s companies and contacts automatically.
        </p>
      </div>

      {connected ? (
        <>
          <p className={styles.pendingNote}>✓ Google is connected.</p>
          <button type="button" className={styles.primaryBtn} onClick={onSkip}>Continue</button>
          <StepLinks onBack={onBack} />
        </>
      ) : (
        <>
          <div className={styles.stack}>
            {(showCreds || credsConfigured === false) && (
              <>
                <input
                  className={`${styles.input} ${styles.inputMono}`}
                  placeholder="Google Client ID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <input
                  className={`${styles.input} ${styles.inputMono}`}
                  placeholder="Google Client secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </>
            )}
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void connect()}
              disabled={busy}
            >
              {busy ? 'Connecting…' : 'Connect Google'}
            </button>
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>
          <StepLinks onBack={onBack} onSkip={onSkip} />
        </>
      )}
    </div>
  )
}
