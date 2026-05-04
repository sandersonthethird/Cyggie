import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ChatAttachmentIPC } from './chat-attachments'

/**
 * Single source of truth mapping a ChatKind to its query channel, abort channel,
 * and the args passed to api.invoke. Closes the existing drift between
 * `handleSubmit` and `handleStop` in the legacy ChatInterface where search-
 * results aborts hit the wrong handler.
 *
 *                                  query                          abort
 *   ─────────────────────────────  ─────────────────────────────  ─────────────────────────────
 *   meeting (single meetingId)     CHAT_QUERY_MEETING             CHAT_ABORT
 *   meetings (search results)      CHAT_QUERY_SEARCH_RESULTS      CHAT_ABORT_ALL
 *   company                        COMPANY_CHAT_QUERY             COMPANY_CHAT_ABORT
 *   contact                        CONTACT_CHAT_QUERY             CONTACT_CHAT_ABORT
 *   global                         CHAT_QUERY_ALL                 CHAT_ABORT_ALL
 */

export type ChatKind =
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'meetings'; meetingIds: string[] }
  | { kind: 'company'; companyId: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'global' }

export interface ChatSendArgs {
  question: string
  attachments?: ChatAttachmentIPC[]
}

export interface ChatChannelDispatch {
  query: string
  abort: string
  buildInvokeArgs: (send: ChatSendArgs) => unknown[]
}

export function chatChannels(k: ChatKind): ChatChannelDispatch {
  switch (k.kind) {
    case 'meeting':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_MEETING,
        abort: IPC_CHANNELS.CHAT_ABORT,
        buildInvokeArgs: ({ question, attachments }) => [k.meetingId, question, attachments],
      }
    case 'meetings':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
        abort: IPC_CHANNELS.CHAT_ABORT_ALL,
        buildInvokeArgs: ({ question, attachments }) => [k.meetingIds, question, attachments],
      }
    case 'company':
      return {
        query: IPC_CHANNELS.COMPANY_CHAT_QUERY,
        abort: IPC_CHANNELS.COMPANY_CHAT_ABORT,
        buildInvokeArgs: ({ question, attachments }) => [{ companyId: k.companyId, question, attachments }],
      }
    case 'contact':
      return {
        query: IPC_CHANNELS.CONTACT_CHAT_QUERY,
        abort: IPC_CHANNELS.CONTACT_CHAT_ABORT,
        buildInvokeArgs: ({ question, attachments }) => [{ contactId: k.contactId, question, attachments }],
      }
    case 'global':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_ALL,
        abort: IPC_CHANNELS.CHAT_ABORT_ALL,
        buildInvokeArgs: ({ question, attachments }) => [{ question, attachments }],
      }
    default: {
      const _exhaustive: never = k
      throw new Error(`unknown ChatKind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
