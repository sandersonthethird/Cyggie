export type CompanyEntityType =
  | 'prospect'
  | 'portfolio'
  | 'pass'
  | 'vc_fund'
  | 'lp'
  | 'customer'
  | 'partner'
  | 'vendor'
  | 'other'
  | 'unknown'

export type CompanyPriority = 'high' | 'further_work' | 'monitor'
export type CompanyRound = 'pre_seed' | 'seed' | 'seed_extension' | 'series_a' | 'series_b'
export type CompanyPipelineStage = 'screening' | 'diligence' | 'decision' | 'documentation' | 'pass'
export type CompanySortBy = 'recent_touch' | 'name'

export interface CompanyListFilter {
  query?: string
  limit?: number
  offset?: number
  view?: 'companies' | 'all' | 'hidden'
  entityTypes?: CompanyEntityType[]
  sortBy?: CompanySortBy
  includeStats?: boolean
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
  contactCount: number
  lastTouchpoint: string | null
  priority: CompanyPriority | null
  postMoneyValuation: number | null
  raiseSize: number | null
  round: CompanyRound | null
  pipelineStage: CompanyPipelineStage | null
  createdAt: string
  updatedAt: string
  // Firmographic / Business Profile
  foundingYear: number | null
  employeeCountRange: string | null
  hqAddress: string | null
  linkedinCompanyUrl: string | null
  twitterHandle: string | null
  crunchbaseUrl: string | null
  angellistUrl: string | null
  sector: string | null
  targetCustomer: string | null
  businessModel: string | null
  productStage: string | null
  revenueModel: string | null
  // Financials
  arr: number | null
  burnRate: number | null
  runwayMonths: number | null
  lastFundingDate: string | null
  totalFundingRaised: number | null
  leadInvestor: string | null
  // Deal Provenance — source fields
  sourceType: string | null
  sourceEntityType: 'company' | 'contact' | null
  sourceEntityId: string | null
  relationshipOwner: string | null
  dealSource: string | null
  warmIntroSource: string | null
  referralContactId: string | null
  nextFollowupDate: string | null
  // Portfolio fields (for entityType = 'portfolio')
  investmentSize: string | null
  ownershipPct: string | null
  followonInvestmentSize: string | null
  totalInvested: string | null
  // Field source tracking — JSON string { fieldName: meetingId }
  fieldSources: string | null
}

export interface CompanyDetail extends CompanySummary {
  industries: string[]
  themes: string[]
  sourceEntityName: string | null
  coInvestorsList: Array<{ id: string; name: string }>
  priorInvestorsList: Array<{ id: string; name: string }>
  coInvestedIn: Array<{ id: string; name: string }>
}

export type CompanyDedupAction = 'skip' | 'delete' | 'merge'

export interface CompanyDuplicateSummary {
  id: string
  canonicalName: string
  primaryDomain: string | null
  websiteUrl: string | null
  entityType: CompanyEntityType
  pipelineStage: CompanyPipelineStage | null
  updatedAt: string
}

export interface CompanyDuplicateGroup {
  key: string
  domain: string | null
  reason: string
  suggestedKeepCompanyId: string
  companies: CompanyDuplicateSummary[]
  /** Set only for fuzzy-name groups (0–100). Omitted for domain-match groups. */
  confidence?: number
}

export interface CompanyDedupDecision {
  groupKey: string
  action: CompanyDedupAction
  keepCompanyId: string
  companyIds: string[]
}

export interface CompanyDedupFailure {
  groupKey: string
  action: CompanyDedupAction
  reason: string
}

export interface CompanyDedupApplyResult {
  reviewedGroups: number
  mergedGroups: number
  deletedGroups: number
  skippedGroups: number
  mergedCompanies: number
  deletedCompanies: number
  failures: CompanyDedupFailure[]
}

export interface CompanyMeetingRef {
  id: string
  title: string
  date: string
  status: string
  durationSeconds: number | null
}

export interface CompanyMeetingSummaryRef {
  meetingId: string
  title: string
  date: string
  summary: string
}

export interface CompanyContactRef {
  id: string
  fullName: string
  email: string | null
  title: string | null
  contactType: string | null
  linkedinUrl: string | null
  isPrimary: boolean
  isPastEmployee?: boolean
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
  threadGroup: string  // COALESCE(thread_id, id) — used for thread-aware unlink
  providerThreadId: string | null
  threadMessageCount: number
  participants: CompanyEmailParticipantRef[]
  accountEmail: string | null
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
  aborted?: boolean
}

export type CompanyTimelineItemType = 'meeting' | 'email' | 'note' | 'decision'
export type CompanyTimelineReferenceType = 'meeting' | 'email' | 'company_note' | 'company_decision_log'

export interface CompanyTimelineItem {
  id: string
  type: CompanyTimelineItemType
  title: string
  occurredAt: string
  subtitle: string | null
  referenceId: string
  referenceType: CompanyTimelineReferenceType
  threadGroup?: string  // present when type === 'email', used for thread-aware bulk unlink
}

export type { Note as CompanyNote } from './note'

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

export type DecisionLogType =
  | 'Investment Approved'
  | 'Pass'
  | 'Increase Allocation'
  | 'Follow-on'
  | 'Write-Off'
  | 'Other'

export interface DecisionNextStep {
  what: string
  byWhom: string | null
  dueDate: string | null
}

export interface DecisionLinkedArtifact {
  type: 'memo' | 'meeting_summary' | 'other'
  refId: string | null
  label: string
}

export interface CompanyDecisionLog {
  id: string
  companyId: string
  decisionType: string
  decisionDate: string
  decisionOwner: string | null
  amountApproved: string | null
  targetOwnership: string | null
  moreIfPossible: boolean
  structure: string | null
  rationale: string[]
  dependencies: string[]
  nextSteps: DecisionNextStep[]
  linkedArtifacts: DecisionLinkedArtifact[]
  createdAt: string
  updatedAt: string
}
