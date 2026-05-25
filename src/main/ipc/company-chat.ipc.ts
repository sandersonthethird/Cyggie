import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  flagFile,
  getFlaggedFileIds,
  getFlaggedFilesDetailed,
  isFlaggedForCompany,
  refreshFlaggedFile,
  unflagFile,
} from '@cyggie/db/sqlite/repositories'
import { abortCompanyChat } from '@cyggie/services/llm/company-chat'
import { chatDispatch } from '@cyggie/services/llm/chat-dispatch'
import { getCurrentUserId } from '../security/current-user'
import { withChatPersistence } from '@cyggie/services/llm/chat-persistence'
import { withProgressSink } from '@cyggie/services/llm/send-progress'
import { createChatProgressSink } from '../lib/ipc-progress-sink'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { validateFileForChatContext } from '../storage/file-manager'
import { notifyPending } from '../services/flagged-file-extraction-worker'
import type { ChatAttachment } from '../../shared/types/chat'

/**
 * Broadcast COMPANY_FLAGS_CHANGED to all renderer windows so any listener
 * (CompanyFiles list, ChatContextSizeBanner) refreshes. Moved out of the
 * repo when withSync wrapping landed (Phase 3) — the IPC handler is the
 * canonical place to fire renderer notifications post-write.
 */
function broadcastFlagsChanged(companyId: string, flagged: boolean): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.COMPANY_FLAGS_CHANGED, { companyId, flagged })
      }
    }
  } catch {
    // No-op in non-Electron test environments.
  }
}

function getCompanyName(companyId: string): string | null {
  const db = getDatabase()
  const row = db.prepare(`SELECT canonical_name FROM org_companies WHERE id = ?`).get(companyId) as
    | { canonical_name: string }
    | undefined
  return row?.canonical_name ?? null
}

export function registerCompanyChatHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPANY_FILE_FLAG_GET, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return getFlaggedFileIds(companyId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE,
    (
      _event,
      data: { companyId: string; fileId: string; fileName: string; mimeType?: string }
    ):
      | { ok: true; flagged: boolean }
      | {
          ok: false
          code: 'MISSING' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DRIVE_SCOPE_INSUFFICIENT'
          message: string
        } => {
      if (!data?.companyId || !data?.fileId) throw new Error('companyId and fileId are required')
      // Phase 3: split the old binary toggleFileFlag into explicit
      // flag/unflag verbs (each carries crisp sync semantics — insert
      // vs delete payload through the outbox).
      const alreadyFlagged = isFlaggedForCompany(data.companyId, data.fileId)
      if (alreadyFlagged) {
        unflagFile({ companyId: data.companyId, fileId: data.fileId })
        broadcastFlagsChanged(data.companyId, false)
        return { ok: true, flagged: false }
      }
      const validation = validateFileForChatContext(data.fileId, data.mimeType)
      if (!validation.ok) {
        console.warn(
          `[chat-flag] reject companyId=${data.companyId} fileId=${data.fileId} code=${validation.code}`
        )
        return { ok: false, code: validation.code, message: validation.message }
      }
      const userId = getCurrentUserId()
      flagFile({
        companyId: data.companyId,
        fileId: data.fileId,
        fileName: data.fileName,
        mimeType: data.mimeType ?? null,
        userId,
        flaggedByUserId: userId,
      })
      broadcastFlagsChanged(data.companyId, true)
      // Wake the extraction worker — it'll process the new 'pending' row.
      notifyPending()
      return { ok: true, flagged: true }
    }
  )

  // Phase 3 — detailed list (extraction state + attribution + drive_version)
  // for the renderer's status chip + ↻ refresh button + "flagged by" label.
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_FILE_FLAG_LIST_DETAILED,
    (_event, companyId: string) => {
      if (!companyId) throw new Error('companyId is required')
      return getFlaggedFilesDetailed(companyId)
    },
  )

  // Phase 3 — explicit refresh gesture: clears extracted_text + bumps
  // flagged_by to the current user; worker re-extracts on the next loop.
  ipcMain.handle(
    IPC_CHANNELS.COMPANY_FILE_FLAG_REFRESH,
    (_event, data: { companyId: string; fileId: string }) => {
      if (!data?.companyId || !data?.fileId) {
        throw new Error('companyId and fileId are required')
      }
      const userId = getCurrentUserId()
      const row = refreshFlaggedFile({
        companyId: data.companyId,
        fileId: data.fileId,
        flaggedByUserId: userId,
      })
      if (!row) {
        return { ok: false as const, code: 'NOT_FLAGGED' as const, message: 'File is not currently flagged for this company.' }
      }
      broadcastFlagsChanged(data.companyId, true)
      notifyPending()
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_CHAT_QUERY,
    async (
      _event,
      data: { companyId: string; question: string; attachments?: ChatAttachment[] }
    ) => {
      if (!data?.companyId || !data?.question?.trim()) {
        throw new Error('companyId and question are required')
      }
      const ctx = deriveChatContext({ companyId: data.companyId })
      if (!ctx) throw new Error('Failed to derive chat context')

      return withChatPersistence({
        contextId: ctx.contextId,
        contextKind: ctx.kind,
        contextLabel: getCompanyName(data.companyId),
        userMessage: { content: data.question.trim(), attachments: data.attachments },
        userId: getCurrentUserId(),
        runLLM: () =>
          withProgressSink(createChatProgressSink(), () =>
            chatDispatch({
              kind: { kind: 'company', companyId: data.companyId },
              question: data.question.trim(),
              attachments: data.attachments,
            }),
          ),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_CHAT_ABORT, () => {
    abortCompanyChat()
  })
}
