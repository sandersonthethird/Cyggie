export interface ChatAttachment {
  name: string
  mimeType: string
  type: 'image' | 'text' | 'pdf'
  data: string // text content for text type; base64 (no data: prefix) for image/pdf types
}

export interface ContextOption {
  type: 'company' | 'contact'
  id: string
  name: string
}

export interface ChatPageContext {
  meetingId?: string
  meetingIds?: string[]
  contextOptions?: ContextOption[]
}
