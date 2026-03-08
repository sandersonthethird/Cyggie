export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dismissed'
export type TaskCategory = 'action_item' | 'decision' | 'follow_up'
export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskSource = 'auto' | 'manual'

export interface Task {
  id: string
  title: string
  description: string | null
  meetingId: string | null
  companyId: string | null
  contactId: string | null
  status: TaskStatus
  category: TaskCategory
  priority: TaskPriority | null
  assignee: string | null
  dueDate: string | null
  source: TaskSource
  sourceSection: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskListItem extends Task {
  meetingTitle: string | null
  meetingDate: string | null
  companyName: string | null
  companyDomain?: string | null
}

export interface TaskListFilter {
  status?: TaskStatus[]
  category?: TaskCategory[]
  priority?: TaskPriority[]
  meetingId?: string
  companyId?: string
  assignee?: string
  hasDueDate?: boolean
  limit?: number
  offset?: number
}

export interface TaskCreateData {
  title: string
  description?: string | null
  meetingId?: string | null
  companyId?: string | null
  contactId?: string | null
  category?: TaskCategory
  priority?: TaskPriority | null
  assignee?: string | null
  dueDate?: string | null
  source?: TaskSource
  sourceSection?: string | null
  extractionHash?: string | null
}

export interface TaskUpdateData {
  title?: string
  description?: string | null
  status?: TaskStatus
  category?: TaskCategory
  priority?: TaskPriority | null
  assignee?: string | null
  dueDate?: string | null
  companyId?: string | null
  contactId?: string | null
}

export interface TaskSummaryStats {
  openCount: number
  inProgressCount: number
  dueThisWeek: number
  overdueCount: number
}

export interface ProposedTask {
  key: string
  title: string
  description: string | null
  meetingId: string | null
  companyId: string | null
  category: TaskCategory
  assignee: string | null
  sourceSection: string | null
  extractionHash: string
}

export interface TaskExtractionResult {
  proposed: ProposedTask[]
  duplicatesSkipped: number
}
