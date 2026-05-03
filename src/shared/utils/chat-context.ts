export type ChatContextKind = 'meeting' | 'company' | 'contact' | 'global'

export interface ChatContext {
  contextId: string
  kind: ChatContextKind
}

/**
 * Single source of truth for the chat contextId scheme. Used by both renderer
 * (for in-memory store keying and hydrate-on-mount) and main (for chat-session
 * persistence). Returns null for the search-results case, which is intentionally
 * not persisted in v1 (contextId would be unstable across searches).
 */
export function deriveChatContext(opts: {
  meetingId?: string | null
  meetingIds?: string[] | null
  companyId?: string | null
  contactId?: string | null
}): ChatContext | null {
  if (opts.companyId) {
    return { contextId: `company:${opts.companyId}`, kind: 'company' }
  }
  if (opts.contactId) {
    return { contextId: `contact:${opts.contactId}`, kind: 'contact' }
  }
  if (opts.meetingIds && opts.meetingIds.length > 0) {
    return null
  }
  if (opts.meetingId) {
    return { contextId: opts.meetingId, kind: 'meeting' }
  }
  return { contextId: 'global-all', kind: 'global' }
}
