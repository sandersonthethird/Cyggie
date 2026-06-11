import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
// T17a A1 followup (caught by plan-eng-review 2026-05-23): write paths in
// this IPC layer used to import directly from `chat-session.repo`, which
// bypassed the sync-wrapped barrel and silently dropped desktop rename /
// pin / archive / delete / createNew / appendModalTurn writes from the
// outbox. Only `chat-persistence.ts` had been migrated in the original
// T17a A1; this layer was missed.
//
// All write paths now go through the barrel so they emit outbox rows via
// `withSync()`. Reads pass through the raw repo (cheap import) since
// reads don't need outbox emission and the barrel's read pass-throughs
// are identical functions.
//
// `endActive` stays raw on purpose — it's a conditional UPDATE-or-DELETE
// that can't be cleanly wrapped (withSync expects a single op). When
// endActive runs INSIDE the wrapped createChatSession (the normal "start
// a new chat for an existing context" flow), the cascade is documented
// as intentionally un-emitted in repositories/index.ts. The IPC's
// CHAT_SESSION_END_ACTIVE handler is a rare external-only path; if a
// future surface needs it to sync, lift endActive into the barrel with
// op-discrimination logic at that point.
import * as chatSessionRepo from '@cyggie/db/sqlite/repositories/chat-session.repo'
import {
  appendChatMessage,
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  pinChatSession,
  renameChatSession,
  setChatSessionAttachedEntities,
  setChatSessionCacheEnabled,
  unpinChatSession,
} from '@cyggie/db/sqlite/repositories'
import { getCurrentUserId } from '../security/current-user'
import type { ChatContextKind } from '../../shared/utils/chat-context'
import type { AttachedContextEntity } from '../../shared/types/chat'

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
      // Stays on the raw repo — see header note on endActive.
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
        attachedContextEntities?: AttachedContextEntity[]
      }
    ) => {
      if (!data?.contextId || !data?.contextKind) {
        throw new Error('contextId and contextKind are required')
      }
      const userId = getCurrentUserId()
      return createChatSession(
        data.contextId,
        data.contextKind,
        data.contextLabel ?? null,
        userId,
        data.attachedContextEntities ?? []
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
      return renameChatSession(data.sessionId, data.title, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_PIN,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      pinChatSession(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_UNPIN,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      unpinChatSession(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_ARCHIVE,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      archiveChatSession(sessionId, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_SET_CACHE_ENABLED,
    (_event, data: { sessionId: string; enabled: boolean }) => {
      if (!data?.sessionId) throw new Error('sessionId is required')
      if (typeof data.enabled !== 'boolean') throw new Error('enabled must be boolean')
      const userId = getCurrentUserId()
      setChatSessionCacheEnabled(data.sessionId, data.enabled, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_SET_ATTACHED_ENTITIES,
    (_event, data: { sessionId: string; entities: AttachedContextEntity[] }) => {
      if (!data?.sessionId) throw new Error('sessionId is required')
      if (!Array.isArray(data.entities)) throw new Error('entities must be an array')
      const userId = getCurrentUserId()
      setChatSessionAttachedEntities(data.sessionId, data.entities, userId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SESSION_DELETE,
    (_event, sessionId: string) => {
      if (!sessionId) throw new Error('sessionId is required')
      const userId = getCurrentUserId()
      deleteChatSession(sessionId, userId)
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
      return appendChatMessage(
        { sessionId: data.sessionId, role: data.role, content: data.content },
        userId
      )
    }
  )
}
