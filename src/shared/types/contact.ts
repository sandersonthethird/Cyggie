export interface ContactSummary {
  id: string
  fullName: string
  firstName: string | null
  lastName: string | null
  normalizedName: string
  email: string | null
  primaryCompanyId: string | null
  title: string | null
  linkedinUrl: string | null
  crmContactId: string | null
  crmProvider: string | null
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
}

export interface ContactSyncResult {
  scannedMeetings: number
  candidates: number
  inserted: number
  updated: number
  skipped: number
  invalid: number
}
