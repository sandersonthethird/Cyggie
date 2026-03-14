export interface ChatAttachment {
  name: string
  mimeType: string
  type: 'image' | 'text'
  data: string // text content for text type; base64 (no data: prefix) for image type
}
