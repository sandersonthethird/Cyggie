export type DigestStatus = 'active' | 'archived'

export type DigestSection =
  | 'priorities'
  | 'new_deals'
  | 'existing_deals'
  | 'portfolio_updates'
  | 'passing'
  | 'admin'
  | 'other'

export interface PartnerMeetingDigest {
  id: string
  weekOf: string                    // ISO date of the Tuesday e.g. '2026-03-17'
  status: DigestStatus
  dismissedSuggestions: string[]    // company IDs dismissed from suggestions banner
  meetingId: string | null          // linked meeting record for transcript reconciliation
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  items?: PartnerMeetingItem[]      // included when fetching a single digest
}

export interface PartnerMeetingDigestSummary {
  id: string
  weekOf: string
  status: DigestStatus
  archivedAt: string | null
  itemCount: number
}

export interface PartnerMeetingItem {
  id: string
  digestId: string
  companyId: string | null          // null for admin items
  companyName: string | null        // denormalized from JOIN
  pipelineStage: string | null      // denormalized from org_companies JOIN; null for admin items
  section: DigestSection
  position: number
  title: string | null              // admin items only
  brief: string | null              // TipTap markdown: AI-generated company brief
  statusUpdate: string | null       // "what happened this week"
  meetingNotes: string | null       // TipTap markdown: live meeting notes
  isDiscussed: boolean
  carryOver: boolean
  createdAt: string
  updatedAt: string
}

export interface AddToSyncInput {
  companyId: string | null          // null for admin items
  section: DigestSection
  title?: string                    // admin items
  brief?: string | null
  statusUpdate?: string | null
}

export interface UpdateItemInput {
  brief?: string | null
  statusUpdate?: string | null
  meetingNotes?: string | null
  isDiscussed?: boolean
  section?: DigestSection
  position?: number
}

export interface DigestSuggestion {
  companyId: string
  companyName: string
  lastTouchpoint: string
  activitySummary: string           // e.g. "1 meeting this week"
}

export interface GenerateBriefResult {
  brief: string | null              // null if LLM failed or returned garbage
}

// ─── Reconciliation types ─────────────────────────────────────────────────────

export interface ReconcileProposalTask {
  title: string
  category: 'action_item' | 'decision' | 'follow_up'
  assignee?: string | null
  dueDate?: string | null           // ISO date string if LLM infers one, otherwise null
}

export interface ReconcileProposal {
  companyId: string
  companyName: string
  noteTitle: string
  noteContent: string               // markdown with source footer appended
  fieldUpdates: { field: string; from: string | null; to: string }[]
  tasks: ReconcileProposalTask[]
  error?: string                    // set if LLM failed; card still shown (skipped by default)
}

export interface ApplyReconciliationInput {
  digestId: string
  meetingId: string | null          // passed through for task.meetingId association
  proposals: {
    companyId: string
    companyName: string             // passed through for error display
    applyNote: boolean
    noteContent: string             // user may have edited
    applyFieldUpdates: boolean
    fieldUpdates: { field: string; to: string }[]
    applyTasks: boolean
    tasks: ReconcileProposalTask[]
  }[]
}

export interface ApplyReconciliationResult {
  applied: number
  failed: { companyId: string; companyName: string; error: string }[]
}
