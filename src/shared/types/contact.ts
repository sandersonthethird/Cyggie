export type ContactType = 'investor' | 'founder' | 'operator'
export type ContactSortBy = 'recent_touch' | 'first_name' | 'last_name' | 'company'

export interface ContactEnrichmentOptions {
  webLookup?: boolean
  webLookupLimit?: number
}

export interface ContactEmailOnboardingOptions extends ContactEnrichmentOptions {
  maxContacts?: number
  ingestOnlyMissingEmailHistory?: boolean
}

export interface ContactSummary {
  id: string
  fullName: string
  firstName: string | null
  lastName: string | null
  normalizedName: string
  email: string | null
  primaryCompanyId: string | null
  primaryCompanyName?: string | null
  title: string | null
  contactType: ContactType | null
  linkedinUrl: string | null
  crmContactId: string | null
  crmProvider: string | null
  meetingCount: number
  emailCount: number
  lastTouchpoint: string | null
  createdAt: string
  updatedAt: string
}

export interface ContactCompanyRef {
  id: string
  canonicalName: string
  primaryDomain: string | null
  websiteUrl: string | null
}

export interface ContactMeetingRef {
  id: string
  title: string
  date: string
  status: string
  durationSeconds: number | null
}

export interface ContactEmailRef {
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
  participants: ContactEmailParticipantRef[]
}

export type EmailParticipantRole = 'from' | 'to' | 'cc' | 'bcc' | 'reply_to'

export interface ContactEmailParticipantRef {
  role: EmailParticipantRole
  email: string
  displayName: string | null
  contactId: string | null
}

export interface ContactDetail extends ContactSummary {
  primaryCompany: ContactCompanyRef | null
  emails: string[]
  meetings: ContactMeetingRef[]
  investorStage: string | null
  city: string | null
  state: string | null
  notes: string | null
  phone: string | null
  twitterHandle: string | null
  otherSocials: string | null
  timezone: string | null
  pronouns: string | null
  birthday: string | null
  university: string | null
  previousCompanies: string | null
  tags: string | null
  relationshipStrength: string | null
  lastMetEvent: string | null
  warmIntroPath: string | null
  fundSize: number | null
  typicalCheckSizeMin: number | null
  typicalCheckSizeMax: number | null
  investmentStageFocus: string | null
  investmentSectorFocus: string | null
  proudPortfolioCompanies: string | null
  noteCount: number
  fieldSources: string | null
}

export interface ContactNote {
  id: string
  contactId: string
  themeId: string | null
  title: string | null
  content: string
  isPinned: boolean
  createdAt: string
  updatedAt: string
}

export type ContactTimelineItemType = 'meeting' | 'email' | 'note'

export interface ContactTimelineItem {
  id: string
  type: ContactTimelineItemType
  title: string
  occurredAt: string
  subtitle: string | null
  referenceId: string
}

export interface ContactEmailIngestResult {
  contactId: string
  contactEmail: string
  accountEmail: string
  queryCount: number
  fetchedMessageCount: number
  insertedMessageCount: number
  updatedMessageCount: number
  linkedMessageCount: number
  linkedContactCount: number
  suggestedFullName: string | null
  aborted?: boolean
}

export interface ContactSyncResult {
  scannedMeetings: number
  candidates: number
  inserted: number
  updated: number
  skipped: number
  invalid: number
}

export interface ContactEnrichmentResult {
  scannedContacts: number
  updatedNames: number
  updatedLinkedinUrls: number
  updatedTitles: number
  linkedCompanies: number
  webLookups: number
  skipped: number
}

export interface ContactEmailOnboardingFailure {
  contactId: string
  contactName: string
  stage: 'ingest' | 'enrich'
  reason: string
}

export interface ContactEmailOnboardingResult {
  scannedContacts: number
  attemptedIngest: number
  skippedAlreadyIngested: number
  ingestedContacts: number
  ingestFailures: number
  enrichedContacts: number
  enrichmentFailures: number
  insertedMessageCount: number
  updatedMessageCount: number
  linkedMessageCount: number
  linkedContactCount: number
  updatedNames: number
  updatedLinkedinUrls: number
  updatedTitles: number
  linkedCompanies: number
  webLookups: number
  skippedEnrichment: number
  failures: ContactEmailOnboardingFailure[]
}

export type ContactEmailOnboardingProgressStage =
  | 'starting'
  | 'checking'
  | 'ingesting'
  | 'enriching'
  | 'completed'
  | 'failed'

export interface ContactEmailOnboardingProgress {
  stage: ContactEmailOnboardingProgressStage
  totalContacts: number
  processedContacts: number
  completedContacts: number
  currentContactId: string | null
  currentContactName: string | null
  attemptedIngest: number
  skippedAlreadyIngested: number
  ingestedContacts: number
  ingestFailures: number
  enrichedContacts: number
  enrichmentFailures: number
}

export type ContactDedupAction = 'skip' | 'delete' | 'merge'

export interface ContactDuplicateSummary {
  id: string
  fullName: string
  email: string | null
  primaryCompanyId: string | null
  primaryCompanyName: string | null
  title: string | null
  updatedAt: string
}

export interface ContactDuplicateGroup {
  key: string
  normalizedName: string
  reason: string
  suggestedKeepContactId: string
  contacts: ContactDuplicateSummary[]
  /** Set only for fuzzy-name groups (0–100). Omitted for exact-match groups. */
  confidence?: number
}

export interface ContactDedupDecision {
  groupKey: string
  action: ContactDedupAction
  keepContactId: string
  contactIds: string[]
}

export interface ContactDedupFailure {
  groupKey: string
  action: ContactDedupAction
  reason: string
}

export interface ContactDedupApplyResult {
  reviewedGroups: number
  mergedGroups: number
  deletedGroups: number
  skippedGroups: number
  mergedContacts: number
  deletedContacts: number
  failures: ContactDedupFailure[]
}

export type ContactDecisionLogType = 'Pass' | 'Advance' | 'Offer' | 'Other'

export interface ContactDecisionLog {
  id: string
  contactId: string
  decisionType: string
  decisionDate: string
  decisionOwner: string | null
  rationale: string[]
  nextSteps: import('./company').DecisionNextStep[]
  createdAt: string
  updatedAt: string
}
