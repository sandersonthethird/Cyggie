import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { queryContact, abortContactChat } from '../llm/contact-chat'

export function registerContactChatHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTACT_CHAT_QUERY,
    async (_event, data: { contactId: string; question: string }) => {
      if (!data?.contactId || !data?.question?.trim()) throw new Error('contactId and question are required')
      return queryContact(data.contactId, data.question.trim())
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_CHAT_ABORT, () => {
    abortContactChat()
  })
}
