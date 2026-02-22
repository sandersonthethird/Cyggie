import type { PipelineSummaryItem, StuckDealItem } from './pipeline'

export type DashboardActivityType = 'meeting' | 'email' | 'note' | 'deal_event'

export interface DashboardActivityItem {
  id: string
  type: DashboardActivityType
  title: string
  subtitle: string | null
  occurredAt: string
  referenceId: string
  referenceType: 'meeting' | 'email' | 'company_note' | 'deal_stage_event'
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
  stuckDeals: StuckDealItem[]
}

export interface DashboardData {
  pipelineSummary: PipelineSummaryItem[]
  recentActivity: DashboardActivityItem[]
  needsAttention: DashboardNeedsAttention
  staleRelationshipDays: number
  stuckDealDays: number
}

export interface DashboardCalendarCompanyContext {
  eventId: string
  companyId: string
  companyName: string
  entityType: string
  lastTouchpoint: string | null
  meetingCount: number
  emailCount: number
  activeDealStage: string | null
}
