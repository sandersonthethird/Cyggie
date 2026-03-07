import type { CompanyPipelineStage, CompanyRound } from './company'
import type { TaskExtractionResult } from './task'

export type CompanySummaryAutoFillField =
  | 'description'
  | 'round'
  | 'raiseSize'
  | 'postMoneyValuation'
  | 'city'
  | 'state'
  | 'pipelineStage'

export interface CompanySummaryUpdateChange {
  field: CompanySummaryAutoFillField
  from: string | number | null
  to: string | number | null
}

export interface CompanySummaryUpdatePayload {
  description?: string | null
  round?: CompanyRound | null
  raiseSize?: number | null
  postMoneyValuation?: number | null
  city?: string | null
  state?: string | null
  pipelineStage?: CompanyPipelineStage | null
}

export interface ContactTypeUpdateProposal {
  contactId: string
  contactName: string
  fromType: string | null
  toType: 'founder'
}

export interface CompanySummaryUpdateProposal {
  companyId: string
  companyName: string
  updates: CompanySummaryUpdatePayload
  changes: CompanySummaryUpdateChange[]
  founderUpdate?: ContactTypeUpdateProposal | null
}

export interface SummaryGenerateResult {
  summary: string
  companyUpdateProposals: CompanySummaryUpdateProposal[]
  taskExtractionResult?: TaskExtractionResult
}
