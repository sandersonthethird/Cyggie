export interface ChatAttachment {
  name: string
  mimeType: string
  type: 'image' | 'text' | 'pdf'
  data: string // text content for text type; base64 (no data: prefix) for image/pdf types
}

// M5 — sources an assistant chat answer drew on (context-attributed by the
// gateway). Renderer-safe mirror of @cyggie/db's Citation (the renderer bundle
// can't import @cyggie/db — native deps). Keep the shape in sync.
export type CitationType = 'meeting' | 'company' | 'contact' | 'note'
export interface Citation {
  type: CitationType
  id: string
  label: string
  timestamp?: number
}

export interface ContextOption {
  type: 'company' | 'contact'
  id: string
  name: string
}

/**
 * A company/contact whose full context is attached to a chat session.
 * Persisted on `chat_sessions.attached_context_entities` (JSON array) and
 * used to drive both the in-panel context chips and the LLM context builder.
 * `label` is the display name captured at attach time (may go stale on rename).
 */
export interface AttachedContextEntity {
  type: 'company' | 'contact'
  id: string
  label: string
}

export interface ChatPageContext {
  meetingId?: string
  meetingIds?: string[]
  contextOptions?: ContextOption[]
}
