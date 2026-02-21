export interface ContactSummary {
  id: string
  fullName: string
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

export interface ContactSyncResult {
  scannedMeetings: number
  candidates: number
  inserted: number
  updated: number
  skipped: number
  invalid: number
}
