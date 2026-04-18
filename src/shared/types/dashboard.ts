import type { PipelineSummaryItem, StalledPipelineCompany } from './pipeline'
import type { CompanyPipelineStage, CompanyEntityType } from './company'

export type DashboardActivityType = 'meeting' | 'email' | 'note'

export type DashboardEntityTypeFilter = Extract<
  CompanyEntityType,
  'portfolio' | 'lp' | 'vc_fund' | 'prospect'
>

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
  companyDomain: string | null
  bodyText: string | null
  snippet: string | null
}

export interface DashboardStaleCompany {
  companyId: string
  companyName: string
  companyDomain?: string | null
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
  pipelineStages: CompanyPipelineStage[] | null   // null = no stage filter (show all)
  entityTypes: DashboardEntityTypeFilter[] | null  // null = no entity type filter (show all)
}

export const DEFAULT_ACTIVITY_FILTER: DashboardActivityFilter = {
  types: ['meeting', 'email'],
  pipelineStages: null,
  entityTypes: null
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
