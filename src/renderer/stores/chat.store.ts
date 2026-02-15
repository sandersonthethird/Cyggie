import { create } from 'zustand'
import type { ChatMessage } from '../../shared/types/meeting'

interface ChatConversation {
  messages: ChatMessage[]
}

interface ChatState {
  // Conversations keyed by meetingId, or 'global' for the Query page
  conversations: Record<string, ChatConversation>

  addMessage: (contextId: string, message: ChatMessage) => void
  clearConversation: (contextId: string) => void
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: {},

  addMessage: (contextId: string, message: ChatMessage) =>
    set((state) => {
      const existing = state.conversations[contextId] ?? { messages: [] }
      return {
        conversations: {
          ...state.conversations,
          [contextId]: {
            messages: [...existing.messages, message]
          }
        }
      }
    }),

  clearConversation: (contextId: string) =>
    set((state) => {
      const { [contextId]: _, ...rest } = state.conversations
      return { conversations: rest }
    })
}))
