import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { abortContactChat } from '@cyggie/services/llm/contact-chat'
import { chatDispatch } from '@cyggie/services/llm/chat-dispatch'
import { withChatPersistence } from '@cyggie/services/llm/chat-persistence'
import { withProgressSink } from '@cyggie/services/llm/send-progress'
import { createChatProgressSink } from '../lib/ipc-progress-sink'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getCurrentUserId } from '../security/current-user'
import { getDatabase } from '@cyggie/db/sqlite/connection'
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
        runLLM: () =>
          withProgressSink(createChatProgressSink(), () =>
            chatDispatch({
              kind: { kind: 'contact', contactId: data.contactId },
              question: data.question.trim(),
              attachments: data.attachments,
            }),
          ),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.CONTACT_CHAT_ABORT, () => {
    abortContactChat()
  })
}
