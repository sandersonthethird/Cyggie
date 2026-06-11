import { create } from 'zustand'
import type { ChatMessage } from '../../shared/types/meeting'
import type { ContextOption, ChatPageContext, AttachedContextEntity } from '../../shared/types/chat'
import type { ChatContextKind } from '../../shared/utils/chat-context'

export type { ContextOption, ChatPageContext }

interface ChatConversation {
  sessionId: string | null
  messages: ChatMessage[]
}

interface PanelSession {
  sessionId: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  // Companies/contacts whose full context is attached to this chat (the
  // "+ Add context" chips). Drives chat routing + the context-size banner.
  attachedEntities: AttachedContextEntity[]
  messages: ChatMessage[]
}

interface ChatState {
  // Bottom-bar conversations keyed by contextId. One slot per context.
  conversations: Record<string, ChatConversation>

  // Detached panel session — single slot, persists across navigation until
  // explicitly closed. Used by the AI Chat side panel and (during the
  // additive period of the rename) the legacy chat history modal.
  panelSession: PanelSession | null

  // Whether the legacy chat-history modal is open. When true with no
  // panelSession, the modal shows the list view. (Will be moved to
  // useChatPanelStore.mode='switcher' in step 4 of the panel rollout.)
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

  // Panel session loaders
  loadPanelSession: (
    sessionId: string,
    contextId: string,
    contextKind: ChatContextKind,
    contextLabel: string | null,
    attachedEntities: AttachedContextEntity[],
    messages: ChatMessage[]
  ) => void
  // Replace the in-memory attached-entity list for the open panel session
  // (after the user adds/removes a chip; persistence is fired separately).
  setPanelAttachedEntities: (entities: AttachedContextEntity[]) => void
  openModalList: () => void
  closeModal: () => void
  appendPanelMessage: (message: ChatMessage) => void
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: {},
  panelSession: null,
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

      // Mirror to panel if it's showing the same session.
      let nextPanel = state.panelSession
      if (
        state.panelSession &&
        existing.sessionId &&
        state.panelSession.sessionId === existing.sessionId
      ) {
        nextPanel = {
          ...state.panelSession,
          messages: [...state.panelSession.messages, message],
        }
      }

      return { conversations: nextConversations, panelSession: nextPanel }
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

  loadPanelSession: (sessionId, contextId, contextKind, contextLabel, attachedEntities, messages) =>
    set({
      modalOpen: true,
      panelSession: {
        sessionId,
        contextId,
        contextKind,
        contextLabel,
        attachedEntities: [...attachedEntities],
        messages: [...messages],
      },
    }),

  setPanelAttachedEntities: (entities) =>
    set((state) =>
      state.panelSession
        ? { panelSession: { ...state.panelSession, attachedEntities: [...entities] } }
        : {}
    ),

  openModalList: () => set({ modalOpen: true }),

  closeModal: () => set({ modalOpen: false, panelSession: null }),

  appendPanelMessage: (message: ChatMessage) =>
    set((state) => {
      if (!state.panelSession) return {}

      const nextPanel = {
        ...state.panelSession,
        messages: [...state.panelSession.messages, message],
      }

      // Mirror to the bottom-bar conversation if it's showing the same session.
      const pageSlot = state.conversations[state.panelSession.contextId]
      let nextConversations = state.conversations
      if (pageSlot && pageSlot.sessionId === state.panelSession.sessionId) {
        nextConversations = {
          ...state.conversations,
          [state.panelSession.contextId]: {
            sessionId: pageSlot.sessionId,
            messages: [...pageSlot.messages, message],
          },
        }
      }

      return { panelSession: nextPanel, conversations: nextConversations }
    }),
}))
