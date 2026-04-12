import { create } from 'zustand'
import type { ChatMessage } from '../../shared/types/meeting'
import type { ContextOption, ChatPageContext } from '../../shared/types/chat'

export type { ContextOption, ChatPageContext }

interface ChatConversation {
  messages: ChatMessage[]
}

interface ChatState {
  // Conversations keyed by contextId (meetingId, 'global-all', 'company:<id>', etc.)
  conversations: Record<string, ChatConversation>

  // Current page's entity context — set by detail pages on mount, cleared on unmount
  pageContext: ChatPageContext | null

  addMessage: (contextId: string, message: ChatMessage) => void
  clearConversation: (contextId: string) => void
  setPageContext: (ctx: ChatPageContext | null) => void
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: {},
  pageContext: null,

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
    }),

  setPageContext: (ctx: ChatPageContext | null) => set({ pageContext: ctx }),
}))
