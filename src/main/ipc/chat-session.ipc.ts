import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as chatSessionRepo from '@cyggie/db/sqlite/repositories/chat-session.repo'
import { getCurrentUserId } from '../security/current-user'
import type { ChatContextKind } from '../../shared/utils/chat-context'

export function registerChatSessionHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
    (
      _event,
      opts: {
        contextId?: string | null
        limit?: number
        offset?: number
        pinnedOnly?: boolean
      } = {}
    ) => {
      return chatSessionRepo.listRecent(opts)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_GET_FOR_CONTEXT,
    (_event, contextId: string) => {
      if (!contextId) throw new Error('contextId is required')
      return chatSessionRepo.getActiveForContext(contextId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
    (_event, sessionId: string, limit?: number, offset?: number) => {
      if (!sessionId) throw new Error('sessionId is required')
      return chatSessionRepo.loadMessages(sessionId, limit ?? 200, offset ?? 0)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_SEARCH,
    (_event, query: string, limit?: number) => {
      if (!query || !query.trim()) return []
      return chatSessionRepo.search(query, limit ?? 50)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_END_ACTIVE,
    (_event, contextId: string) => {
      if (!contextId) return
      const userId = getCurrentUserId()
      chatSessionRepo.endActive(contextId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_CREATE_NEW,
    (
      _event,
      data: {
        contextId: string
        contextKind: ChatContextKind
        contextLabel?: string | null
      }
    ) => {
      if (!data?.contextId || !data?.contextKind) {
        throw new Error('contextId and contextKind are required')
      }
      const userId = getCurrentUserId()
      return chatSessionRepo.createNew(
        data.contextId,
        data.contextKind,
        data.contextLabel ?? null,
        userId
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_RENAME,
    (_event, data: { sessionId: string; title: string }) => {
      if (!data?.sessionId || !data?.title) {
        throw new Error('sessionId and title are required')
      }
      const userId = getCurrentUserId()
      return chatSessionRepo.rename(data.sessionId, data.title, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_PIN,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      chatSessionRepo.pin(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_UNPIN,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      chatSessionRepo.unpin(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_ARCHIVE,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      chatSessionRepo.archive(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_DELETE,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      chatSessionRepo.deleteSession(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_APPEND_MODAL_TURN,
    (
      _event,
      data: {
        sessionId: string
        role: 'user' | 'assistant' | 'system'
        content: string
      }
    ) => {
      if (!data?.sessionId || !data?.role || !data?.content) {
        throw new Error('sessionId, role, and content are required')
      }
      const userId = getCurrentUserId()
      return chatSessionRepo.appendMessage(
        { sessionId: data.sessionId, role: data.role, content: data.content },
        userId
      )
    }
  )
}
