import styles from './PipelineStepper.module.css'

export interface PipelineStage {
  /** The enum value stored in the database (null = "Sourced" pre-pipeline state) */
  value: string | null
  /** Display label shown to the user */
  label: string
}

interface PipelineStepperProps {
  /** Ordered list of pipeline stages */
  stages: PipelineStage[]
  /** Current stage value (null = pre-pipeline / "Sourced") */
  currentValue: string | null
  /** Days the company has been in the current stage */
  daysInStage: number
  /** Called when user clicks a stage dot/label */
  onStageClick?: (value: string | null) => void
}

/**
 * Horizontal pipeline stage progression bar.
 *
 * Visual states:
 *   ● completed (before current)
 *   ◉ current (ring halo)
 *   ○ future (after current)
 *
 * Stage values map to display labels — no data model changes needed.
 * "pass" is excluded (it's an exit state, not a progression step).
 */
export function PipelineStepper({
  stages,
  currentValue,
  daysInStage,
  onStageClick,
}: PipelineStepperProps) {
  const currentIndex = stages.findIndex((s) => s.value === currentValue)

  return (
    <div className={styles.wrapper}>
      <div className={styles.topRow}>
        <div className={styles.track}>
          {stages.map((stage, i) => {
            const isCompleted = i < currentIndex
            const isCurrent = i === currentIndex
            const isFuture = i > currentIndex

            return (
              <span key={stage.value ?? '__null'} style={{ display: 'contents' }}>
                {i > 0 && (
                  <div
                    className={`${styles.segment} ${i <= currentIndex ? styles.segmentCompleted : ''}`}
                  />
                )}
                <div
                  className={`${styles.dot} ${
                    isCurrent ? styles.dotCurrent
                      : isCompleted ? styles.dotCompleted
                      : styles.dotFuture
                  }`}
                  onClick={() => onStageClick?.(stage.value)}
                  title={stage.label}
                />
              </span>
            )
          })}
        </div>
        <span className={styles.daysLabel}>
          {daysInStage} day{daysInStage !== 1 ? 's' : ''} in stage
        </span>
      </div>

      <div className={styles.labels}>
        {stages.map((stage, i) => (
          <span
            key={stage.value ?? '__null'}
            className={`${styles.stageLabel} ${i === currentIndex ? styles.stageLabelCurrent : ''}`}
            onClick={() => onStageClick?.(stage.value)}
          >
            {stage.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Default company pipeline stages with display label mapping */
export const COMPANY_PIPELINE_STAGES: PipelineStage[] = [
  { value: null, label: 'Sourced' },
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Partner' },
  { value: 'documentation', label: 'Term Sheet' },
]
