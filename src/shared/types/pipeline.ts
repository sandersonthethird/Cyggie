import type { CompanyPipelineStage } from './company'

export interface PipelineSummaryItem {
  pipelineStage: CompanyPipelineStage
  label: string
  count: number
}

export interface StalledPipelineCompany {
  companyId: string
  companyName: string
  companyDomain?: string | null
  pipelineStage: CompanyPipelineStage
  lastTouchpoint: string | null
  daysSinceTouch: number
}
