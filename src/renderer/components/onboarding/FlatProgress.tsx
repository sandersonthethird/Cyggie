// =============================================================================
// FlatProgress — flat segmented progress bar shown ABOVE and OUTSIDE the card.
// "Step N of 4 · <Label>" on the left, percentage on the right, then a track of
// four rounded segments (crimson up to and including the current step, navy-line
// for upcoming). Display-only; step nav is via the Back/Continue buttons.
// =============================================================================

import styles from './Onboarding.module.css'

export function FlatProgress({
  steps,
  current,
  percent,
}: {
  steps: string[]
  /** 0-based index of the current setup step. */
  current: number
  percent: number
}) {
  return (
    <div className={styles.progress}>
      <div className={styles.progressHeader}>
        <span className={styles.progressLabel}>
          Step {current + 1} of {steps.length} ·{' '}
          <span className={styles.progressCurrent}>{steps[current]}</span>
        </span>
        <span className={styles.progressPct}>{percent}%</span>
      </div>
      <div className={styles.track}>
        {steps.map((label, i) => (
          <div
            key={label}
            className={`${styles.seg} ${i <= current ? styles.segFilled : ''}`}
          />
        ))}
      </div>
    </div>
  )
}
