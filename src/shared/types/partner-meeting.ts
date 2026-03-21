export type DigestStatus = 'active' | 'archived'

export type DigestSection =
  | 'priorities'
  | 'new_deals'
  | 'existing_deals'
  | 'portfolio_updates'
  | 'passing'
  | 'admin'

export interface PartnerMeetingDigest {
  id: string
  weekOf: string                    // ISO date of the Tuesday e.g. '2026-03-17'
  status: DigestStatus
  dismissedSuggestions: string[]    // company IDs dismissed from suggestions banner
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
