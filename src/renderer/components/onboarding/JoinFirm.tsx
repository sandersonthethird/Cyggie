import { useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import styles from './onboarding.module.css'

type JoinResult = { ok: true; firm: { name: string } } | { ok: false; code: string; message: string }

// The dispatcher only routes here when the gateway detected a pending invite for
// this verified email (action='join_firm'), so the default path is a one-click
// email-match accept (no token). A manual invite-code fallback is offered too.
export function JoinFirm({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')

  const accept = async (token?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await api.invoke<JoinResult>(IPC_CHANNELS.CYGGIE_FIRM_JOIN, token ? { token } : {})
    if (!r.ok) {
      setError(joinErrorCopy(r.code, r.message))
      setBusy(false)
      return
    }
    // Success: status broadcast (firm_id set) re-routes the gate to the app.
  }

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>You've been invited to a workspace</h1>
      <p className={styles.sub}>
        {email ? <>Joining as <strong>{email}</strong>.</> : 'Join your firm to start collaborating.'}
      </p>

      <button className={styles.primary} onClick={() => void accept()} disabled={busy}>
        {busy ? 'Joining…' : 'Join workspace'}
      </button>
      {error && <p className={styles.error}>{error}</p>}

      {!showCode ? (
        <button className={styles.linkBtn} onClick={() => setShowCode(true)}>
          Have an invite code instead?
        </button>
      ) : (
        <div className={styles.codeRow}>
          <input
            className={styles.input}
            value={code}
            placeholder="Paste invite code"
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            className={styles.secondary}
            onClick={() => void accept(code.trim())}
            disabled={busy || code.trim().length < 20}
          >
            Join
          </button>
        </div>
      )}
    </div>
  )
}

function joinErrorCopy(code: string, fallback: string): string {
  switch (code) {
    case 'NO_PENDING_INVITE':
      return 'No pending invite for this email. Ask an admin to add you, then try again.'
    case 'INVITE_EXPIRED':
      return 'That invite expired. Ask an admin to send a new one.'
    case 'INVITE_REVOKED':
      return 'That invite was revoked.'
    case 'INVITE_EMAIL_MISMATCH':
      return 'This invite was issued to a different email address.'
    case 'INVITE_NOT_FOUND':
      return 'That invite code is invalid or already used.'
    default:
      return fallback
  }
}
