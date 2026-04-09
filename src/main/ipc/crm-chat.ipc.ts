import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { queryAll, abortAllChat } from '../llm/crm-chat'
import type { ChatAttachment } from '../../shared/types/chat'

export function registerCrmChatHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_ALL,
    async (_event, data: { question: string; attachments?: ChatAttachment[] }) => {
      if (!data?.question?.trim()) throw new Error('question is required')
      return queryAll(data.question.trim(), data.attachments ?? [])
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT_ALL, () => {
    abortAllChat()
  })
}
