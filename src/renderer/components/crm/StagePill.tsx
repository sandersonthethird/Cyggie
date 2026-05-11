import type { CompanyPipelineStage } from '../../../shared/types/company'
import { COMPANY_STAGE_OPTIONS } from '../common/PipelineStepper'
import styles from './StagePill.module.css'

const STAGE_LABELS: Record<CompanyPipelineStage, string> = Object.fromEntries(
  COMPANY_STAGE_OPTIONS.map((s) => [s.value, s.label]),
) as Record<CompanyPipelineStage, string>

const STAGE_CLASS: Record<CompanyPipelineStage, string> = {
  screening: styles.screening,
  diligence: styles.diligence,
  decision: styles.decision,
  documentation: styles.documentation,
  portfolio: styles.portfolio,
  pass: styles.pass,
}

interface StagePillProps {
  stage: CompanyPipelineStage
  className?: string
}

export function StagePill({ stage, className }: StagePillProps) {
  return (
    <span className={`${styles.pill} ${STAGE_CLASS[stage] ?? ''} ${className ?? ''}`}>
      {STAGE_LABELS[stage] ?? stage}
    </span>
  )
}
