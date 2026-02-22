import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as companyChatRepo from '../database/repositories/company-chat.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'

export function registerCompanyChatHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPANY_CHAT_LIST, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return companyChatRepo.listConversations(companyId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_CHAT_CREATE,
    (
      _event,
      data: {
        companyId: string
        title: string
        themeId?: string | null
        modelProvider?: string | null
        modelName?: string | null
      }
    ) => {
      if (!data?.companyId) throw new Error('companyId is required')
      if (!data?.title?.trim()) throw new Error('title is required')
      const userId = getCurrentUserId()
      const conversation = companyChatRepo.createConversation(data, userId)
      logAudit(userId, 'company_conversation', conversation.id, 'create', data)
      return conversation
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANY_CHAT_MESSAGES, (_event, conversationId: string) => {
    if (!conversationId) throw new Error('conversationId is required')
    return companyChatRepo.listMessages(conversationId)
  })

  ipcMain.handle(
    IPC_CHANNELS.COMPANY_CHAT_APPEND,
    (
      _event,
      data: {
        conversationId: string
        role: 'user' | 'assistant' | 'system'
        content: string
        citationsJson?: string | null
        tokenCount?: number | null
      }
    ) => {
      if (!data?.conversationId) throw new Error('conversationId is required')
      if (!data?.content?.trim()) throw new Error('content is required')
      const userId = getCurrentUserId()
      const message = companyChatRepo.appendMessage(data, userId)
      logAudit(userId, 'company_conversation_message', message.id, 'create', {
        conversationId: data.conversationId,
        role: data.role
      })
      return message
    }
  )
}
