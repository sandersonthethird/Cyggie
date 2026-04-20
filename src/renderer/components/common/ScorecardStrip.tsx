import styles from './ScorecardStrip.module.css'

export interface ScorecardMetric {
  label: string
  value: string | number
  /** Suffix shown after value (e.g. "/100") */
  suffix?: string
  /** Delta change indicator (e.g. "+6", "-2") */
  delta?: string
  /** Direction of the delta for color coding */
  deltaDir?: 'up' | 'down' | 'neutral'
  /** Additional detail text below the value (e.g. "1 due today") */
  detail?: string
}

interface ScorecardStripProps {
  metrics: ScorecardMetric[]
  onMetricClick?: (index: number) => void
}

/**
 * 3-column metric strip with hairline dividers.
 * Each cell shows label, value with optional suffix, delta, and detail text.
 */
export function ScorecardStrip({ metrics, onMetricClick }: ScorecardStripProps) {
  return (
    <div className={styles.strip}>
      {metrics.map((m, i) => (
        <div
          key={i}
          className={styles.cell}
          onClick={() => onMetricClick?.(i)}
        >
          <span className={styles.label}>{m.label}</span>
          <div className={styles.valueRow}>
            <span className={styles.value}>{m.value}</span>
            {m.suffix && <span className={styles.suffix}>{m.suffix}</span>}
          </div>
          {m.delta && (
            <span className={`${styles.delta} ${
              m.deltaDir === 'up' ? styles.deltaUp
                : m.deltaDir === 'down' ? styles.deltaDown
                : styles.deltaNeutral
            }`}>
              {m.delta}
            </span>
          )}
          {m.detail && <span className={styles.detail}>{m.detail}</span>}
        </div>
      ))}
    </div>
  )
}
