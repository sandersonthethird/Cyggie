import { Fragment, useState } from 'react'
import type { CompanyPipelineStage } from '../../../shared/types/company'
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
 *   Active:  ● completed   ◉ current (ring halo)   ○ future
 *   Passed:  all dots gray, label "Passed · Nd ago", click on a dot
 *            opens a confirm dialog before re-opening the deal.
 */
export function PipelineStepper({
  stages,
  currentValue,
  daysInStage,
  onStageClick,
}: PipelineStepperProps) {
  const [pendingReopen, setPendingReopen] = useState<{ value: string | null; label: string } | null>(null)
  const isPassed = currentValue === 'pass'
  // In the Pass branch, slice off Portfolio so we render only the 5 active stages.
  // findIndex returns -1, so every dot falls through to dotFuture (gray) automatically.
  const renderedStages = isPassed ? stages.filter((s) => s.value !== 'portfolio') : stages
  const currentIndex = renderedStages.findIndex((s) => s.value === currentValue)

  function handleClick(stage: PipelineStage) {
    if (isPassed) {
      setPendingReopen({ value: stage.value, label: stage.label })
      return
    }
    onStageClick?.(stage.value)
  }

  function confirmReopen() {
    if (pendingReopen) onStageClick?.(pendingReopen.value)
    setPendingReopen(null)
  }

  return (
    <div className={`${styles.wrapper} ${isPassed ? styles.passedTrack : ''}`}>
      <div className={styles.row}>
        <div
          className={styles.grid}
          style={{ gridTemplateColumns: `${'auto 1fr '.repeat(renderedStages.length - 1)}auto` }}
        >
          {renderedStages.map((stage, i) => {
            const isCompleted = !isPassed && i < currentIndex
            const isCurrent = !isPassed && i === currentIndex

            return (
              <Fragment key={stage.value ?? '__null'}>
                {i > 0 && (
                  <div
                    className={`${styles.segment} ${!isPassed && i <= currentIndex ? styles.segmentCompleted : ''}`}
                    style={{ gridRow: 1, gridColumn: 2 * i }}
                  />
                )}
                <div
                  className={`${styles.dot} ${
                    isCurrent ? styles.dotCurrent
                      : isCompleted ? styles.dotCompleted
                      : styles.dotFuture
                  }`}
                  style={{ gridRow: 1, gridColumn: 2 * i + 1 }}
                  onClick={() => handleClick(stage)}
                  title={stage.label}
                />
                <span
                  className={`${styles.stageLabel} ${i === currentIndex ? styles.stageLabelCurrent : ''}`}
                  style={{ gridRow: 2, gridColumn: 2 * i + 1 }}
                  onClick={() => handleClick(stage)}
                >
                  {stage.label}
                </span>
              </Fragment>
            )
          })}
        </div>
        <span className={isPassed ? styles.passedDaysLabel : styles.daysLabel}>
          {isPassed
            ? (daysInStage === 0 ? 'Passed today' : `Passed · ${daysInStage}d ago`)
            : `${daysInStage} day${daysInStage !== 1 ? 's' : ''} in stage`}
        </span>
      </div>

      {pendingReopen && (
        <div className={styles.confirmOverlay} onClick={() => setPendingReopen(null)}>
          <div className={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmTitle}>Re-open this passed deal?</div>
            <div className={styles.confirmBody}>
              Move this company to <strong>{pendingReopen.label}</strong>. This is reversible from the stage chip.
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setPendingReopen(null)}>Cancel</button>
              <button className={styles.confirmOk} onClick={confirmReopen}>Re-open</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Canonical pipeline-stage list. All 7 entries (Sourced → Pass) — single source of truth. */
export const COMPANY_PIPELINE_STAGES_FULL: PipelineStage[] = [
  { value: null,            label: 'Sourced'    },
  { value: 'screening',     label: 'Screening'  },
  { value: 'diligence',     label: 'Diligence'  },
  { value: 'decision',      label: 'Partner'    },
  { value: 'documentation', label: 'Term Sheet' },
  { value: 'portfolio',     label: 'Portfolio'  },
  { value: 'pass',          label: 'Pass'       },
]

/** Stages rendered by the stepper in normal (non-Pass) state. Excludes terminal Pass. */
export const COMPANY_PIPELINE_STAGES: PipelineStage[] = COMPANY_PIPELINE_STAGES_FULL.filter(
  (s) => s.value !== 'pass',
)

/** Selectable stage values for dropdowns / filters / table. Excludes Sourced (=null). */
export const COMPANY_STAGE_OPTIONS: { value: CompanyPipelineStage; label: string }[] =
  COMPANY_PIPELINE_STAGES_FULL.filter((s) => s.value !== null) as { value: CompanyPipelineStage; label: string }[]

/**
 * Kanban columns: 4 active stages + 2 "Recent" terminal columns. Terminal
 * columns are muted to signal they're short-lived (companies roll off after
 * the configured Recent stage window — see `pipelinePassExpiryDays` setting,
 * default 14 days). The renderer applies the muted CSS class when `muted` is
 * truthy.
 */
export const COMPANY_KANBAN_STAGES: { value: CompanyPipelineStage; label: string; muted?: boolean }[] = [
  { value: 'screening',     label: 'Screening'                       },
  { value: 'diligence',     label: 'Diligence'                       },
  { value: 'decision',      label: 'Partner'                         },
  { value: 'documentation', label: 'Term Sheet'                      },
  { value: 'portfolio',     label: 'Recent Portfolio', muted: true   },
  { value: 'pass',          label: 'Recent Pass',      muted: true   },
]
