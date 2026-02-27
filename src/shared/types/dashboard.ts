import type { PipelineSummaryItem, StalledPipelineCompany } from './pipeline'

export type DashboardActivityType = 'meeting' | 'email' | 'note'

export interface DashboardActivityItem {
  id: string
  type: DashboardActivityType
  title: string
  subtitle: string | null
  occurredAt: string
  referenceId: string
  referenceType: 'meeting' | 'email' | 'company_note'
  companyId: string | null
  companyName: string | null
}

export interface DashboardStaleCompany {
  companyId: string
  companyName: string
  lastTouchpoint: string | null
  daysSinceTouch: number
  meetingCount: number
  emailCount: number
}

export interface DashboardNeedsAttention {
  staleCompanies: DashboardStaleCompany[]
  stalledCompanies: StalledPipelineCompany[]
}

export interface DashboardData {
  pipelineSummary: PipelineSummaryItem[]
  recentActivity: DashboardActivityItem[]
  needsAttention: DashboardNeedsAttention
  staleRelationshipDays: number
  stalledPipelineDays: number
  activityFilter: DashboardActivityFilter
}

export interface DashboardActivityFilter {
  types: DashboardActivityType[]
  emailCompanyFilter: 'all' | 'pipeline_portfolio'
}

export const DEFAULT_ACTIVITY_FILTER: DashboardActivityFilter = {
  types: ['meeting', 'email'],
  emailCompanyFilter: 'pipeline_portfolio'
}

export interface DashboardCalendarCompanyContext {
  eventId: string
  companyId: string
  companyName: string
  entityType: string
  lastTouchpoint: string | null
  meetingCount: number
  emailCount: number
  pipelineStage: string | null
}
