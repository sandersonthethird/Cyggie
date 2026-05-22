import { api } from './client'

// M5-thin client wrapper for the gateway's stateless one-shot chat + notes
// enhance endpoints. No session persistence here — caller owns the message
// list. Follow-ups: sessions, streaming, citations (see TODOS M5).

export interface SendChatMessageInput {
  message: string
  meetingId?: string
}

export interface SendChatMessageResult {
  reply: string
}

export function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  return api.post<SendChatMessageResult>('/chat/messages', input)
}

export interface EnhanceNotesInput {
  content: string
  meetingId?: string
}

export interface EnhanceNotesResult {
  enhanced: string
}

export function enhanceNotes(input: EnhanceNotesInput): Promise<EnhanceNotesResult> {
  return api.post<EnhanceNotesResult>('/chat/enhance-notes', input)
}
