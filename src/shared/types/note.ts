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
  folderPath: string | null
  importSource: string | null
  // Denormalized from JOIN, only present on list queries
  companyName?: string | null
  contactName?: string | null
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
}

export interface NoteUpdateData {
  title?: string | null
  content?: string
  companyId?: string | null
  contactId?: string | null
  isPinned?: boolean
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
