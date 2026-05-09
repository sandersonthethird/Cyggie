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

export const ENTITY_TYPE_OPTIONS: { value: CompanyEntityType; label: string }[] = [
  { value: 'unknown',   label: 'Unknown'   },
  { value: 'prospect',  label: 'Prospect'  },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'pass',      label: 'Pass'      },
  { value: 'vc_fund',   label: 'Investor'  },
  { value: 'lp',        label: 'LP'        },
  { value: 'customer',  label: 'Customer'  },
  { value: 'partner',   label: 'Partner'   },
  { value: 'vendor',    label: 'Vendor'    },
  { value: 'other',     label: 'Other'     },
]

export type CompanyPortfolioFund = 'fund_i' | 'fund_ii' | 'fund_iii' | 'fund_iv' | 'fund_v' | 'personal'

export const PORTFOLIO_FUND_OPTIONS: { value: CompanyPortfolioFund; label: string }[] = [
  { value: 'fund_i',    label: 'Fund I'    },
  { value: 'fund_ii',   label: 'Fund II'   },
  { value: 'fund_iii',  label: 'Fund III'  },
  { value: 'fund_iv',   label: 'Fund IV'   },
  { value: 'fund_v',    label: 'Fund V'    },
  { value: 'personal',  label: 'Personal'  },
]

export type CompanyStatus = 'active' | 'exited' | 'shut_down'

export const STATUS_OPTIONS: { value: CompanyStatus; label: string }[] = [
  { value: 'active',    label: 'Active'    },
  { value: 'exited',    label: 'Exited'    },
  { value: 'shut_down', label: 'Shut Down' },
]

export type CompanyPriority = 'high' | 'further_work' | 'monitor'
export type CompanyRound = 'pre_seed' | 'seed' | 'seed_extension' | 'series_a' | 'series_b' | 'series_c' | 'series_d'

export type InvestmentSecurityType = 'preferred_stock' | 'safe' | 'convertible_note' | 'common_stock'

export const INVESTMENT_SECURITY_OPTIONS: { value: InvestmentSecurityType; label: string }[] = [
  { value: 'preferred_stock', label: 'Preferred Stock' },
  { value: 'safe', label: 'SAFE' },
  { value: 'convertible_note', label: 'Convertible Note' },
  { value: 'common_stock', label: 'Common Stock' },
]
export type CompanyPipelineStage = 'screening' | 'diligence' | 'decision' | 'documentation' | 'pass'
export type CompanySortBy = 'recent_touch' | 'name'

export interface CompanyListFilter {
  query?: string
  limit?: number
  offset?: number
  view?: 'companies' | 'all' | 'hidden' | 'stubs'
  entityTypes?: CompanyEntityType[]
  sortBy?: CompanySortBy
  includeStats?: boolean
  includeInvestorNames?: boolean
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
  status: CompanyStatus
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
  industry: string | null
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
  portfolioFund: CompanyPortfolioFund | null
  investmentSize: string | null
  ownershipPct: string | null
  followonInvestmentSize: string | null
  totalInvested: string | null
  // New portfolio investment fields
  investmentMark: number | null
  investmentRound: CompanyRound | null
  initialInvestmentSecurity: string | null
  dateOfInitialInvestment: string | null
  initialRoundSize: number | null
  lastCompanyValuation: number | null
  followonCheck: number | null
  followonDate: string | null
  followonCheck2: number | null
  followonDate2: string | null
  // Denormalized list-view fields (conditional GROUP_CONCAT joins)
  coInvestorNames: string | null
  coInvestorsList: Array<{ id: string; name: string; domain: string | null }>
  priorInvestorNames: string | null
  priorInvestorsList: Array<{ id: string; name: string; domain: string | null }>
  subsequentInvestorNames: string | null
  subsequentInvestorsList: Array<{ id: string; name: string; domain: string | null }>
  /** Linked company for lead investor (preferred over leadInvestor text). */
  leadInvestorCompany: { id: string; name: string; domain: string | null } | null
  // Field source tracking — JSON string { fieldName: meetingId }
  fieldSources: string | null
  // AI-generated key takeaways (bullet-point summary)
  keyTakeaways: string | null
}

export interface CompanyDetail extends CompanySummary {
  themes: string[]
  sourceEntityName: string | null
  // coInvestorsList / priorInvestorsList / subsequentInvestorsList inherited from CompanySummary
  coInvestedIn: Array<{ id: string; name: string; domain: string | null }>
  /**
   * For each co-investor of THIS company, how many OTHER portfolio companies share that investor.
   * Keyed by investor_company_id; only entries with count > 0 are included.
   * Phase 2C: powers "↑ N more" badges on co-investor chips.
   */
  coInvestorOverlaps: Record<string, number>
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
  /** Count of populated enrichment fields (out of ~20 tracked), as a proxy for record richness. */
  populatedFieldCount: number
  meetingCount: number
  emailCount: number
  noteCount: number
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

/**
 * Per-field overrides for mergeCompanies. Keys are snake_case org_companies
 * column names. Values are the FINAL value to write to the target row before
 * source is deleted. Caller (renderer) computes the chosen value; the backend
 * just applies it. Columns not in MERGEABLE_COLUMNS are ignored.
 */
export type MergeFieldOverrides = Record<string, unknown>

/** Scalar field comparison for the merge review UI. */
export interface MergeFieldDiff {
  /** snake_case DB column. */
  column: string
  /** Human-readable label for display. */
  label: string
  /** Stringified for display; null when target is missing the value. */
  targetValue: string | null
  sourceValue: string | null
}

/**
 * Pre-merge preview: classifies every mergeable scalar column on the source vs.
 * target into conflicts (both have values, differ) or auto-fill (target empty,
 * source has value). Equal values and both-empty are silently skipped. Array
 * fields auto-union and surface only as a count.
 */
export interface CompanyMergePreview {
  target: { id: string; canonicalName: string }
  source: { id: string; canonicalName: string }
  conflicts: MergeFieldDiff[]
  /** Source value will be applied to target unless caller overrides to null/target. */
  autoFill: MergeFieldDiff[]
  /** For transparency only — these auto-union behind the scenes. */
  arrayUnions: Array<{ name: string; addedCount: number }>
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
  /** LinkedIn-derived background summary; populated by contact enrichment. */
  keyTakeaways: string | null
  isPrimary: boolean
  isPastEmployee?: boolean
  meetingCount: number
  lastInteractedAt: string | null
  updatedAt: string
}

/**
 * Counts of internal + external sources used to build a single memo version.
 * Returned by INVESTMENT_MEMO_GENERATE so the renderer can:
 *   - fire a "skipped web research" toast when externalResearchQueryCount===0
 *   - render a "Based on N meetings, M notes…" footer below the memo
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  meetingCount + summaryCount + transcriptCount counts the same  │
 *   │  meetings differently:                                            │
 *   │    meetingCount     = total meetings linked to the company       │
 *   │    summaryCount     = subset that had an AI summary loaded       │
 *   │    transcriptCount  = remainder loaded as raw transcript          │
 *   │  So summaryCount + transcriptCount ≤ meetingCount.               │
 *   └─────────────────────────────────────────────────────────────────┘
 */
export interface MemoGenerateMeta {
  meetingCount: number
  summaryCount: number
  transcriptCount: number
  companyNoteCount: number
  contactNoteCount: number
  contactKeyTakeawayCount: number
  fileCount: number
  emailCount: number
  externalResearchQueryCount: number
  externalResearchResultCount: number
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

export interface InvestmentMemoVersionSummary {
  id: string
  memoId: string
  versionNumber: number
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
