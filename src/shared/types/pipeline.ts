export interface PipelineConfig {
  id: string
  name: string
  isDefault: boolean
  createdAt: string
}

export interface PipelineStage {
  id: string
  pipelineConfigId: string
  label: string
  slug: string
  sortOrder: number
  color: string | null
  isTerminal: boolean
  createdAt: string
}

export interface PipelineDealCard {
  id: string
  companyId: string
  companyName: string
  stageId: string | null
  stageLabel: string
  stageColor: string | null
  stageDurationDays: number
  lastTouchpoint: string | null
  contactName: string | null
  contactEmail: string | null
  createdAt: string
  updatedAt: string
}

export interface PipelineColumn {
  stage: PipelineStage
  deals: PipelineDealCard[]
}

export interface PipelineBoard {
  config: PipelineConfig
  stages: PipelineStage[]
  deals: PipelineDealCard[]
  columns: PipelineColumn[]
}

export interface DealStageHistoryEvent {
  id: string
  dealId: string
  fromStage: string | null
  toStage: string
  eventTime: string
  note: string | null
  source: string
}

export interface CompanyActiveDeal {
  id: string
  companyId: string
  stageId: string | null
  stageLabel: string
  stageColor: string | null
  stageUpdatedAt: string
  stageDurationDays: number
  createdAt: string
  updatedAt: string
  history: DealStageHistoryEvent[]
}

export interface PipelineSummaryItem {
  stageId: string
  label: string
  color: string | null
  count: number
}

export interface StuckDealItem {
  dealId: string
  companyId: string
  companyName: string
  stageLabel: string
  stageDurationDays: number
  lastTouchpoint: string | null
}
