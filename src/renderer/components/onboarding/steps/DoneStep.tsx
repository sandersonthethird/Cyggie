import { Check } from 'lucide-react'
import appIcon from '../../../assets/app-icon.png'
import styles from '../Onboarding.module.css'

export interface DoneSummary {
  workspace: string | null
  googleConnected: boolean
  keysConfigured: boolean
  inviteCount: number
}

/**
 * Step 5 — "You're all set." Summarizes what was configured with real
 * done-or-skipped state, then enters the app (sets onboardingComplete).
 */
export function DoneStep({
  summary,
  onEnter,
}: {
  summary: DoneSummary
  onEnter: () => void
}) {
  const row = (label: string, done: boolean, doneText: string) => (
    <div className={styles.summaryRow}>
      <span className={styles.summaryLabel}>{label}</span>
      {done ? (
        <span className={styles.badgeDone}>
          <Check size={13} strokeWidth={3} /> {doneText}
        </span>
      ) : (
        <span className={styles.badgeSkipped}>Skipped</span>
      )}
    </div>
  )

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.hero}>
        <img src={appIcon} alt="Cyggie" className={styles.heroIcon} />
        <div className={styles.headBlock}>
          <h1 className={styles.heading}>You’re all set</h1>
          <p className={styles.sub}>
            {summary.workspace
              ? `${summary.workspace} is ready. You can finish anything you skipped in Settings.`
              : 'Cyggie is ready. You can finish anything you skipped in Settings.'}
          </p>
        </div>
      </div>

      <div className={styles.summaryList}>
        {row('Workspace', Boolean(summary.workspace), summary.workspace ?? 'Set')}
        {row('Google', summary.googleConnected, 'Connected')}
        {row('AI & recording keys', summary.keysConfigured, 'Added')}
        {row(
          'Team',
          summary.inviteCount > 0,
          `${summary.inviteCount} invited`,
        )}
      </div>

      <button type="button" className={styles.primaryBtn} onClick={onEnter}>
        Enter Cyggie
      </button>
    </div>
  )
}
