import { useCallback } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ChatContextKind } from '../../shared/utils/chat-context'

/**
 * Shared mutation hook used by the AIChats page rows/cards AND ChatHistoryModal.
 *
 *   ┌───────────────┐
 *   │ ChatRow / Card│ optimistic update on the row
 *   └──────┬────────┘
 *          │ pin/unpin/archive/delete/rename
 *          ▼
 *   ┌──────────────────┐    on error → revert + toast
 *   │ useChatActions   │
 *   └──────┬───────────┘
 *          │ IPC
 *          ▼
 *   chat-session.ipc.ts → chatSessionRepo
 *
 * Each handler returns a Promise that resolves once the IPC call returns. The
 * caller is responsible for the optimistic UI update (so that hover-state stays
 * fast); the hook re-throws so the caller can revert on failure.
 */

export interface ChatSessionRow {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  previewText: string | null
  messageCount: number
  isActive: boolean
  isPinned: boolean
  isArchived: boolean
  lastMessageAt: string
}

export function useChatActions() {
  const pin = useCallback(async (sessionId: string) => {
    await api.invoke(IPC_CHANNELS.CHAT_SESSION_PIN, sessionId)
  }, [])

  const unpin = useCallback(async (sessionId: string) => {
    await api.invoke(IPC_CHANNELS.CHAT_SESSION_UNPIN, sessionId)
  }, [])

  const archive = useCallback(async (sessionId: string) => {
    await api.invoke(IPC_CHANNELS.CHAT_SESSION_ARCHIVE, sessionId)
  }, [])

  const deleteSession = useCallback(async (sessionId: string) => {
    await api.invoke(IPC_CHANNELS.CHAT_SESSION_DELETE, sessionId)
  }, [])

  const rename = useCallback(async (sessionId: string, title: string) => {
    await api.invoke(IPC_CHANNELS.CHAT_SESSION_RENAME, { sessionId, title })
  }, [])

  return { pin, unpin, archive, delete: deleteSession, rename }
}
