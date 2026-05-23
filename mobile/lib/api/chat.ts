import { api } from './client'

// M5-thin client wrapper for the gateway's stateless one-shot chat
// endpoint. No session persistence — caller owns the message list.
// Follow-ups: sessions, streaming, citations (see TODOS M5 — T17-T20).
//
// The /chat/enhance-notes endpoint that lived here has been removed.
// Desktop-parity Enhance (transcript → AI summary via template) now
// lives in lib/api/meetings.ts::enhanceMeeting().

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
