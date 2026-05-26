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
  /** Stage the deal was in immediately before being moved to Pass. When set
   *  alongside currentValue='pass', dots up-to-and-including this stage render
   *  red-completed and the Pass dot gets the halo — "got to Diligence, then
   *  passed." When null, falls back to legacy all-gray rendering. */
  passedFromStage?: string | null
  /** Called when user clicks a stage dot/label */
  onStageClick?: (value: string | null) => void
}

/**
 * Horizontal pipeline stage progression bar.
 *
 *   Active:  ● completed   ◉ current (ring halo)   ○ future
 *   Passed (with passedFromStage): dots 0..passedFromStage filled red, halo
 *            on Pass; click any dot opens a confirm dialog before re-opening.
 *   Passed (legacy, passedFromStage=null): all dots gray under passedTrack
 *            opacity; click any dot opens the same confirm dialog.
 */
export function PipelineStepper({
  stages,
  currentValue,
  daysInStage,
  passedFromStage,
  onStageClick,
}: PipelineStepperProps) {
  const [pendingReopen, setPendingReopen] = useState<{ value: string | null; label: string } | null>(null)
  const isPassed = currentValue === 'pass'
  const passedIdx = isPassed && passedFromStage != null
    ? stages.findIndex((s) => s.value === passedFromStage)
    : -1
  const hasPassedHistory = isPassed && passedIdx >= 0
  const currentIndex = stages.findIndex((s) => s.value === currentValue)

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

  // Pass dot sits as an alternative terminal next to Portfolio — widen the
  // column before it so the visual gap signals the fork. No segment is
  // rendered into the Pass dot below.
  const colTemplate = stages
    .map((s, i) => (i === 0 ? 'auto' : (s.value === 'pass' ? '2fr auto' : '1fr auto')))
    .join(' ')

  // Legacy passed-without-history rows keep the muted opacity wrapper. When
  // we have history, the dot fill itself tells the story, so no muting.
  const wrapperClass = isPassed && !hasPassedHistory
    ? `${styles.wrapper} ${styles.passedTrack}`
    : styles.wrapper

  return (
    <div className={wrapperClass}>
      <div className={styles.row}>
        <div className={styles.grid} style={{ gridTemplateColumns: colTemplate }}>
          {stages.map((stage, i) => {
            const isPassDot = stage.value === 'pass'
            // Dot fill computation:
            //   - active stages: dots before currentIndex are completed,
            //     currentIndex gets the halo, everything after is future
            //   - passed with history: dots up-to-and-including passedIdx are
            //     completed, the Pass dot gets the halo, everything else future
            //   - passed without history: every dot falls through to future
            //     (the passedTrack opacity wrapper handles the visual)
            const isCompleted = hasPassedHistory
              ? (!isPassDot && i <= passedIdx)
              : (!isPassed && i < currentIndex)
            const isCurrent = hasPassedHistory
              ? isPassDot
              : (!isPassed && i === currentIndex)

            // Segment between dot i-1 and dot i. Skip the segment leading INTO
            // the Pass dot — Portfolio and Pass are alternative terminal
            // states, not sequential, so the gap reads as a fork.
            const showSegment = i > 0 && !isPassDot
            const segmentCompleted = hasPassedHistory
              ? i <= passedIdx
              : (!isPassed && i <= currentIndex)

            return (
              <Fragment key={stage.value ?? '__null'}>
                {showSegment && (
                  <div
                    className={`${styles.segment} ${segmentCompleted ? styles.segmentCompleted : ''}`}
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
