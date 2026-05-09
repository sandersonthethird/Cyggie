import styles from './ConfidenceChip.module.css'

/**
 * Three-state colored dot for evidence confidence.
 *   high   = green
 *   medium = amber
 *   low    = red
 *
 * Rendered inline next to a claim or in the EvidenceSidebar header.
 */

export type Confidence = 'high' | 'medium' | 'low'

const LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

export function ConfidenceChip({ confidence, label }: { confidence: Confidence; label?: boolean }) {
  return (
    <span className={`${styles.chip} ${styles[confidence]}`} title={LABEL[confidence]} role="img" aria-label={LABEL[confidence]}>
      <span className={styles.dot} />
      {label ? <span className={styles.label}>{LABEL[confidence].split(' ')[0]}</span> : null}
    </span>
  )
}
