import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getFlaggedFileIds, toggleFileFlag } from '../database/repositories/company-file-flags.repo'
import { queryCompany, abortCompanyChat } from '../llm/company-chat'
import { getCurrentUserId } from '../security/current-user'
import { withChatPersistence } from '../llm/chat-persistence'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getDatabase } from '../database/connection'
import type { ChatAttachment } from '../../shared/types/chat'

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
    (_event, data: { companyId: string; fileId: string; fileName: string }) => {
      if (!data?.companyId || !data?.fileId) throw new Error('companyId and fileId are required')
      return toggleFileFlag(data.companyId, data.fileId, data.fileName)
    }
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
        runLLM: () => queryCompany(data.companyId, data.question.trim(), data.attachments),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_CHAT_ABORT, () => {
    abortCompanyChat()
  })
}
