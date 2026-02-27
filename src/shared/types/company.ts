export type CompanyEntityType =
  | 'prospect'
  | 'portfolio'
  | 'pass'
  | 'vc_fund'
  | 'customer'
  | 'partner'
  | 'vendor'
  | 'other'
  | 'unknown'

export type CompanyPriority = 'high' | 'further_work' | 'monitor'
export type CompanyRound = 'pre_seed' | 'seed' | 'seed_extension' | 'series_a' | 'series_b'
export type CompanyPipelineStage = 'screening' | 'diligence' | 'decision' | 'documentation' | 'pass'

export interface CompanyListFilter {
  query?: string
  limit?: number
  offset?: number
  view?: 'companies' | 'all'
  entityTypes?: CompanyEntityType[]
}

export interface CompanySummary {
  id: string
  canonicalName: string
  normalizedName: string
  description: string | null
  primaryDomain: string | null
  websiteUrl: string | null
  city: string | null
  state: string | null
  stage: string | null
  status: string
  crmProvider: string | null
  crmCompanyId: string | null
  entityType: CompanyEntityType
  includeInCompaniesView: boolean
  classificationSource: 'manual' | 'auto'
  classificationConfidence: number | null
  meetingCount: number
  emailCount: number
  noteCount: number
  lastTouchpoint: string | null
  priority: CompanyPriority | null
  postMoneyValuation: number | null
  raiseSize: number | null
  round: CompanyRound | null
  pipelineStage: CompanyPipelineStage | null
  createdAt: string
  updatedAt: string
}

export interface CompanyDetail extends CompanySummary {
  industries: string[]
  themes: string[]
}

export interface CompanyMeetingRef {
  id: string
  title: string
  date: string
  status: string
  durationSeconds: number | null
}

export interface CompanyContactRef {
  id: string
  fullName: string
  email: string | null
  title: string | null
  meetingCount: number
  lastInteractedAt: string | null
  updatedAt: string
}

export interface CompanyEmailRef {
  id: string
  subject: string | null
  fromEmail: string
  fromName: string | null
  receivedAt: string | null
  sentAt: string | null
  snippet: string | null
  bodyText: string | null
  isUnread: boolean
  threadId: string | null
  threadMessageCount: number
  participants: CompanyEmailParticipantRef[]
}

export type EmailParticipantRole = 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'

export interface CompanyEmailParticipantRef {
  role: EmailParticipantRole
  email: string
  displayName: string | null
  contactId: string | null
}

export interface CompanyFileRef {
  id: string
  meetingId: string
  title: string
  date: string
  status: string
  hasTranscript: boolean
  hasNotes: boolean
  hasSummary: boolean
  hasRecording: boolean
  artifactCount: number
}

export interface CompanyDriveFileRef {
  id: string
  name: string
  mimeType: string
  modifiedAt: string | null
  webViewLink: string | null
  sizeBytes: number | null
  parentFolderName: string | null
}

export interface CompanyEmailIngestResult {
  companyId: string
  accountEmail: string
  cues: {
    contactEmails: string[]
    domains: string[]
  }
  queryCount: number
  fetchedMessageCount: number
  insertedMessageCount: number
  updatedMessageCount: number
  linkedMessageCount: number
  linkedContactCount: number
}

export type CompanyTimelineItemType = 'meeting' | 'email' | 'note'
export type CompanyTimelineReferenceType = 'meeting' | 'email' | 'company_note'

export interface CompanyTimelineItem {
  id: string
  type: CompanyTimelineItemType
  title: string
  occurredAt: string
  subtitle: string | null
  referenceId: string
  referenceType: CompanyTimelineReferenceType
}

export interface CompanyNote {
  id: string
  companyId: string
  themeId: string | null
  title: string | null
  content: string
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export interface InvestmentMemo {
  id: string
  companyId: string
  themeId: string | null
  dealId: string | null
  title: string
  status: 'draft' | 'review' | 'final' | 'archived'
  latestVersionNumber: number
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface InvestmentMemoVersion {
  id: string
  memoId: string
  versionNumber: number
  contentMarkdown: string
  structuredJson: string | null
  changeNote: string | null
  createdBy: string | null
  createdAt: string
}

export interface InvestmentMemoWithLatest extends InvestmentMemo {
  latestVersion: InvestmentMemoVersion | null
}
