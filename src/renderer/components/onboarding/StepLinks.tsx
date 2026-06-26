// =============================================================================
// StepLinks — the quiet underline-link nav row under a step's primary button.
// "Back" sits just to the left of "Skip for now"; both use the same understated
// link style (no buttons). Either link is optional per step.
// =============================================================================

import styles from './Onboarding.module.css'

export function StepLinks({
  onBack,
  onSkip,
  skipLabel = 'Skip for now',
}: {
  onBack?: () => void
  onSkip?: () => void
  skipLabel?: string
}) {
  if (!onBack && !onSkip) return null
  return (
    <div className={styles.linkRow}>
      {onBack && (
        <button type="button" className={styles.skipLink} onClick={onBack}>
          Back
        </button>
      )}
      {onSkip && (
        <button type="button" className={styles.skipLink} onClick={onSkip}>
          {skipLabel}
        </button>
      )}
    </div>
  )
}
