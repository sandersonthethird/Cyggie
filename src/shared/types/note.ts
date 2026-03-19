export interface Note {
  id: string
  title: string | null
  content: string
  companyId: string | null
  contactId: string | null
  sourceMeetingId: string | null
  themeId: string | null
  isPinned: boolean
  createdByUserId: string | null
  updatedByUserId: string | null
  createdAt: string
  updatedAt: string
  // Denormalized from JOIN, only present on list queries
  companyName?: string | null
  contactName?: string | null
}

export type NoteFilterView = 'all' | 'untagged' | 'tagged'

export type ImportFormat = 'apple-notes' | 'notion' | 'generic'

export interface NoteCreateData {
  title?: string | null
  content: string
  companyId?: string | null
  contactId?: string | null
  themeId?: string | null
  sourceMeetingId?: string | null
}

export interface NoteUpdateData {
  title?: string | null
  content?: string
  companyId?: string | null
  contactId?: string | null
  isPinned?: boolean
  themeId?: string | null
}

export interface TagSuggestion {
  companyId: string | null
  contactId: string | null
  companyName: string | null
  contactName: string | null
  confidence: number  // 0–100
  reasoning: string
}
