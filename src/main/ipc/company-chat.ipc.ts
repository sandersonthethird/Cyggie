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
import { getCurrentUserId } from '../security/current-user'
import { validateFileForChatContext } from '../storage/file-manager'
import { notifyPending } from '../services/flagged-file-extraction-worker'

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

// NOTE: the company-scoped chat-query handler (COMPANY_CHAT_QUERY) was removed
// when chat routing unified on the multi-entity `entities` path — the renderer
// now routes every company/contact chat through CHAT_QUERY_ENTITIES, which
// reuses queryCompany internally for the single-entity case. This file retains
// only the company file-flag handlers (still used by the Files tab + chat banner).
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

}
