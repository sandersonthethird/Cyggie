import { create } from 'zustand'
import type { ChatMessage } from '../../shared/types/meeting'
import type { ContextOption, ChatPageContext } from '../../shared/types/chat'
import type { ChatContextKind } from '../../shared/utils/chat-context'

export type { ContextOption, ChatPageContext }

interface ChatConversation {
  sessionId: string | null
  messages: ChatMessage[]
}

interface ModalConversation {
  sessionId: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  messages: ChatMessage[]
}

interface ChatState {
  // Bottom-bar conversations keyed by contextId. One slot per context.
  conversations: Record<string, ChatConversation>

  // Detached modal conversation — single slot, persists across navigation
  // until explicitly closed.
  modalConversation: ModalConversation | null

  // Whether the modal is open. When true with no modalConversation, modal
  // shows the list view.
  modalOpen: boolean

  // Current page's entity context — set by detail pages on mount, cleared on unmount
  pageContext: ChatPageContext | null

  addMessage: (contextId: string, message: ChatMessage) => void
  clearConversation: (contextId: string) => void
  setPageContext: (ctx: ChatPageContext | null) => void

  // Set or clear the active sessionId for a contextId without touching messages.
  setSessionId: (contextId: string, sessionId: string | null) => void

  // Replace the in-memory state for a contextId with a fully-hydrated session
  // (used by useChatHydrate when loading the active session for the current page).
  hydrateConversation: (contextId: string, sessionId: string, messages: ChatMessage[]) => void

  // Modal state
  loadModalSession: (
    sessionId: string,
    contextId: string,
    contextKind: ChatContextKind,
    contextLabel: string | null,
    messages: ChatMessage[]
  ) => void
  openModalList: () => void
  closeModal: () => void
  appendModalMessage: (message: ChatMessage) => void
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: {},
  modalConversation: null,
  modalOpen: false,
  pageContext: null,

  addMessage: (contextId: string, message: ChatMessage) =>
    set((state) => {
      const existing = state.conversations[contextId] ?? { sessionId: null, messages: [] }
      const nextConversations = {
        ...state.conversations,
        [contextId]: {
          sessionId: existing.sessionId,
          messages: [...existing.messages, message],
        },
      }

      // Mirror to modal if the modal is showing the same session.
      let nextModal = state.modalConversation
      if (
        state.modalConversation &&
        existing.sessionId &&
        state.modalConversation.sessionId === existing.sessionId
      ) {
        nextModal = {
          ...state.modalConversation,
          messages: [...state.modalConversation.messages, message],
        }
      }

      return { conversations: nextConversations, modalConversation: nextModal }
    }),

  clearConversation: (contextId: string) =>
    set((state) => {
      const { [contextId]: _, ...rest } = state.conversations
      return { conversations: rest }
    }),

  setPageContext: (ctx: ChatPageContext | null) => set({ pageContext: ctx }),

  setSessionId: (contextId: string, sessionId: string | null) =>
    set((state) => {
      const existing = state.conversations[contextId] ?? { sessionId: null, messages: [] }
      return {
        conversations: {
          ...state.conversations,
          [contextId]: { sessionId, messages: existing.messages },
        },
      }
    }),

  hydrateConversation: (contextId: string, sessionId: string, messages: ChatMessage[]) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [contextId]: { sessionId, messages: [...messages] },
      },
    })),

  loadModalSession: (sessionId, contextId, contextKind, contextLabel, messages) =>
    set({
      modalOpen: true,
      modalConversation: {
        sessionId,
        contextId,
        contextKind,
        contextLabel,
        messages: [...messages],
      },
    }),

  openModalList: () => set({ modalOpen: true }),

  closeModal: () => set({ modalOpen: false, modalConversation: null }),

  appendModalMessage: (message: ChatMessage) =>
    set((state) => {
      if (!state.modalConversation) return {}

      const nextModal = {
        ...state.modalConversation,
        messages: [...state.modalConversation.messages, message],
      }

      // Mirror to the bottom-bar conversation if it's showing the same session.
      const pageSlot = state.conversations[state.modalConversation.contextId]
      let nextConversations = state.conversations
      if (pageSlot && pageSlot.sessionId === state.modalConversation.sessionId) {
        nextConversations = {
          ...state.conversations,
          [state.modalConversation.contextId]: {
            sessionId: pageSlot.sessionId,
            messages: [...pageSlot.messages, message],
          },
        }
      }

      return { modalConversation: nextModal, conversations: nextConversations }
    }),
}))
