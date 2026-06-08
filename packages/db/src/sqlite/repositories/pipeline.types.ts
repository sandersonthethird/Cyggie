// Pipeline / deal domain types consumed by deal.repo.ts and pipeline-config.repo.ts.
//
// These describe the shapes the SQLite repositories return. They live alongside
// the repos (rather than in @shared/types/pipeline) because they are internal to
// the db package — no renderer / gateway / service code consumes them. The two
// cross-cutting shapes that ARE shared (PipelineSummaryItem, StalledPipelineCompany)
// continue to come from @shared/types/pipeline.

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

export interface DealStageHistoryEvent {
  id: string
  dealId: string
  fromStage: string | null
  toStage: string
  eventTime: string
  note: string | null
  source: string
}

export interface PipelineBoardColumn {
  stage: PipelineStage
  deals: PipelineDealCard[]
}

export interface PipelineBoard {
  config: PipelineConfig
  stages: PipelineStage[]
  deals: PipelineDealCard[]
  columns: PipelineBoardColumn[]
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

// Per-stage deal count for the configurable pipeline (keyed by the dynamic
// pipeline_stages.id, not the fixed CompanyPipelineStage enum). Distinct from
// @shared/types/pipeline's PipelineSummaryItem, which keys off the legacy
// company-level pipeline enum.
export interface PipelineStageSummaryItem {
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
