import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { queryContact, abortContactChat } from '../llm/contact-chat'
import { withChatPersistence } from '../llm/chat-persistence'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getCurrentUserId } from '../security/current-user'
import { getDatabase } from '../database/connection'
import type { ChatAttachment } from '../../shared/types/chat'

function getContactName(contactId: string): string | null {
  const db = getDatabase()
  const row = db.prepare(`SELECT full_name FROM contacts WHERE id = ?`).get(contactId) as
    | { full_name: string | null }
    | undefined
  return row?.full_name ?? null
}

export function registerContactChatHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTACT_CHAT_QUERY,
    async (
      _event,
      data: { contactId: string; question: string; attachments?: ChatAttachment[] }
    ) => {
      if (!data?.contactId || !data?.question?.trim()) {
        throw new Error('contactId and question are required')
      }
      const ctx = deriveChatContext({ contactId: data.contactId })
      if (!ctx) throw new Error('Failed to derive chat context')
      return withChatPersistence({
        contextId: ctx.contextId,
        contextKind: ctx.kind,
        contextLabel: getContactName(data.contactId),
        userMessage: { content: data.question.trim(), attachments: data.attachments },
        userId: getCurrentUserId(),
        runLLM: () => queryContact(data.contactId, data.question.trim(), data.attachments),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_CHAT_ABORT, () => {
    abortContactChat()
  })
}
