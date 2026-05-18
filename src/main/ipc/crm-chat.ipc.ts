import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { abortAllChat } from '@cyggie/services/llm/crm-chat'
import { chatDispatch } from '@cyggie/services/llm/chat-dispatch'
import { withChatPersistence } from '@cyggie/services/llm/chat-persistence'
import { withProgressSink } from '@cyggie/services/llm/send-progress'
import { createChatProgressSink } from '../lib/ipc-progress-sink'
import { deriveChatContext } from '../../shared/utils/chat-context'
import { getCurrentUserId } from '../security/current-user'
import type { ChatAttachment } from '../../shared/types/chat'

export function registerCrmChatHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_ALL,
    async (_event, data: { question: string; attachments?: ChatAttachment[] }) => {
      if (!data?.question?.trim()) throw new Error('question is required')
      const ctx = deriveChatContext({})
      if (!ctx) throw new Error('Failed to derive chat context')
      return withChatPersistence({
        contextId: ctx.contextId,
        contextKind: ctx.kind,
        contextLabel: 'Global',
        userMessage: { content: data.question.trim(), attachments: data.attachments },
        userId: getCurrentUserId(),
        runLLM: () =>
          withProgressSink(createChatProgressSink(), () =>
            chatDispatch({
              kind: { kind: 'global' },
              question: data.question.trim(),
              attachments: data.attachments ?? [],
            }),
          ),
        extractText: (response: string) => response,
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT_ALL, () => {
    abortAllChat()
  })
}
