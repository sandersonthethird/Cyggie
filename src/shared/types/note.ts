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
  // Soft-delete (cross-device delete replication). Set by softDeleteNote (an
  // UPDATE that syncs like an edit); all reads filter deleted_at IS NULL, so a
  // Note handed to the UI always has deletedAt == null. Carried on the type so
  // the soft-delete's outbox payload reaches the gateway. Hard delete (orphan/
  // admin) doesn't use these.
  deletedAt: string | null
  deletedByUserId: string | null
  folderPath: string | null
  importSource: string | null
  // Denormalized from JOIN, only present on list queries
  companyName?: string | null
  contactName?: string | null
  meetingTitle?: string | null
  // Stamped by the main process (NOT stored): true when this note is owned by a
  // teammate (firm-shared, pulled read-only) rather than the current user. The
  // renderer disables editing; the gateway would reject a foreign write anyway.
  readOnly?: boolean
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
