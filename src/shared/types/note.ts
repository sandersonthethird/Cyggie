export interface Note {
  id: string
  title: string | null
  content: string
  companyId: string | null
  contactId: string | null
  sourceMeetingId: string | null
  themeId: string | null
  isPinned: boolean
  // Per-note privacy override. A *tagged* note is firm-visible by default
  // (isPrivate = false); true keeps it owner-only regardless of tags. Untagged
  // notes are private regardless. Enforced at the gateway
  // (api-gateway/src/notes/visibility.ts); desktop is single-user.
  isPrivate: boolean
  createdByUserId: string | null
  updatedByUserId: string | null
  createdAt: string
  updatedAt: string
  folderPath: string | null
  importSource: string | null
  // Denormalized from JOIN, only present on list queries
  companyName?: string | null
  contactName?: string | null
  meetingTitle?: string | null
}

export type NoteFilterView = 'all' | 'untagged' | 'tagged' | 'unfoldered'

export type ImportFormat = 'apple-notes' | 'notion' | 'generic'

export interface NoteCreateData {
  title?: string | null
  content: string
  companyId?: string | null
  contactId?: string | null
  themeId?: string | null
  sourceMeetingId?: string | null
  folderPath?: string | null
  importSource?: string | null
  isPrivate?: boolean
}

export interface NoteUpdateData {
  title?: string | null
  content?: string
  companyId?: string | null
  contactId?: string | null
  isPinned?: boolean
  isPrivate?: boolean
  themeId?: string | null
  folderPath?: string | null
}

export interface TagSuggestion {
  companyId: string | null
  contactId: string | null
  companyName: string | null
  contactName: string | null
  confidence: number  // 0–100
  reasoning: string
}
