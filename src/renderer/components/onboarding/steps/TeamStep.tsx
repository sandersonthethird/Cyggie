import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../../../api'
import { IPC_CHANNELS } from '../../../../shared/constants/channels'
import { isValidEmail } from '../onboarding-logic'
import { StepLinks } from '../StepLinks'
import { useVoiceLine } from '../../../hooks/useVoice'
import styles from '../Onboarding.module.css'

/**
 * Step 4 — invite teammates by email. Validates format, allows add/remove of
 * many, and "Continue" works with zero. Invites are held in local flow state +
 * acked through the ONBOARDING_TEAM_INVITE stub (no gateway endpoint on this
 * branch). Skippable.
 */
export function TeamStep({
  invites,
  onAdd,
  onRemove,
  onBack,
  onContinue,
}: {
  invites: string[]
  onAdd: (email: string) => void
  onRemove: (email: string) => void
  onBack: () => void
  onContinue: () => void
}) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const sub = useVoiceLine('onboarding', 'team')

  const add = (): void => {
    const value = email.trim().toLowerCase()
    if (!isValidEmail(value)) {
      setError('Enter a valid email address.')
      return
    }
    if (invites.includes(value)) {
      setError('That email is already on the list.')
      return
    }
    onAdd(value)
    void api.invoke(IPC_CHANNELS.ONBOARDING_TEAM_INVITE, { email: value }).catch(() => {})
    setEmail('')
    setError(null)
  }

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Invite your team</h1>
        <p className={styles.sub}>{sub}</p>
      </div>

      <div className={styles.stack}>
        <div className={styles.inviteRow}>
          <input
            className={styles.input}
            type="email"
            placeholder="teammate@yourfirm.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
          />
          <button type="button" className={styles.addBtn} onClick={add}>Add</button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}

        {invites.length === 0 ? (
          <p className={styles.empty}>No invites yet — you can add teammates later.</p>
        ) : (
          <ul className={styles.inviteList}>
            {invites.map((inv) => (
              <li key={inv} className={styles.inviteItem}>
                <span>{inv}</span>
                <button
                  type="button"
                  className={styles.removeBtn}
                  aria-label={`Remove ${inv}`}
                  onClick={() => onRemove(inv)}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button type="button" className={styles.primaryBtn} onClick={onContinue}>
        {invites.length > 0 ? 'Continue' : 'Skip for now'}
      </button>
      <StepLinks onBack={onBack} />
    </div>
  )
}
