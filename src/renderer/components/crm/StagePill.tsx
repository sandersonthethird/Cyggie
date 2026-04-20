import type { CompanyPipelineStage } from '../../../shared/types/company'
import styles from './StagePill.module.css'

const STAGE_LABELS: Record<CompanyPipelineStage, string> = {
  screening: 'Screening',
  diligence: 'Diligence',
  decision: 'Decision',
  documentation: 'Docs',
  pass: 'Pass',
}

const STAGE_CLASS: Record<CompanyPipelineStage, string> = {
  screening: styles.screening,
  diligence: styles.diligence,
  decision: styles.decision,
  documentation: styles.documentation,
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
