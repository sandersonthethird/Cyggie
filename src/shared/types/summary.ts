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
  | 'industry'

export interface CompanySummaryUpdateChange {
  field: string  // CompanySummaryAutoFillField for built-in fields; 'industry' also included
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
  industry?: string | null
  fieldSources?: string | null  // serialized JSON: { description: meetingId, round: meetingId, ... }
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
  customFieldUpdates?: CustomFieldProposedUpdate[]
  founderUpdate?: ContactTypeUpdateProposal | null
}

export type ContactSummaryAutoFillField =
  | 'title' | 'phone' | 'linkedinUrl' | 'company'
  | 'fundSize' | 'typicalCheckSizeMin' | 'typicalCheckSizeMax'
  | 'investmentStageFocus' | 'investmentSectorFocus' | 'investmentSectorFocusNotes'

export interface ContactSummaryUpdateChange {
  field: string  // ContactSummaryAutoFillField for built-in/investor fields, or custom field label
  from: string | null
  to: string | null
}

export interface ContactSummaryUpdatePayload {
  title?: string | null
  phone?: string | null
  linkedinUrl?: string | null
  fieldSources?: string | null  // serialized JSON: { title: meetingId, phone: meetingId, ... }
  fundSize?: number | null
  typicalCheckSizeMin?: number | null
  typicalCheckSizeMax?: number | null
  investmentStageFocus?: string | null
  investmentSectorFocus?: string | null
  investmentSectorFocusNotes?: string | null
}

export interface CustomFieldProposedUpdate {
  fieldDefinitionId: string
  label: string
  fieldType: string
  newValue: string | number | boolean | string[] | null
  fromDisplay: string | null
  toDisplay: string
}

export interface ContactCompanyLinkProposal {
  companyId: string
  companyName: string
}

export interface ContactSummaryUpdateProposal {
  contactId: string
  contactName: string
  updates: ContactSummaryUpdatePayload
  companyLink?: ContactCompanyLinkProposal
  changes: ContactSummaryUpdateChange[]
  customFieldUpdates?: CustomFieldProposedUpdate[]
}

export interface SummaryGenerateResult {
  summary: string
  companyUpdateProposals: CompanySummaryUpdateProposal[]
  taskExtractionResult?: TaskExtractionResult
  contactUpdateProposals: ContactSummaryUpdateProposal[]
}

export type EnrichmentFailureReason =
  | 'no_content'
  | 'llm_failed'
  | 'parse_failed'
  | 'company_not_found'

export type EnrichmentResult =
  | { ok: true; proposal: CompanySummaryUpdateProposal }
  | { ok: false; reason: EnrichmentFailureReason }
