import { IPC_CHANNELS, type IpcChannel } from '../../shared/constants/channels'
import type { ChatAttachmentIPC } from './chat-attachments'
import type { AttachedContextEntity } from '../../shared/types/chat'
import type { ChatContextKind } from '../../shared/utils/chat-context'

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
 *   entities (1+ company/contact)  CHAT_QUERY_ENTITIES            CHAT_ABORT_ALL
 *   global                         CHAT_QUERY_ALL                 CHAT_ABORT_ALL
 *
 * NOTE: the old single-entity `company`/`contact` kinds were removed when chat
 * routing unified on `entities`. queryEntities reuses queryCompany/queryContact
 * internally for the 1-entity case, so single-entity behavior is preserved
 * server-side. The `entities` kind carries the OPEN session's persistence anchor
 * (contextId/contextKind/contextLabel) — the attached list overrides routing
 * but never changes the session row's identity.
 */

export type ChatKind =
  | { kind: 'meeting'; meetingId: string; refs?: AttachedContextEntity[] }
  | { kind: 'meetings'; meetingIds: string[] }
  | {
      kind: 'entities'
      refs: AttachedContextEntity[]
      contextId: string
      contextKind: ChatContextKind
      contextLabel: string | null
    }
  | { kind: 'global' }

export interface ChatSendArgs {
  question: string
  attachments?: ChatAttachmentIPC[]
}

export interface ChatChannelDispatch {
  query: IpcChannel
  abort: IpcChannel
  buildInvokeArgs: (send: ChatSendArgs) => unknown[]
}

export function chatChannels(k: ChatKind): ChatChannelDispatch {
  switch (k.kind) {
    case 'meeting':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_MEETING,
        abort: IPC_CHANNELS.CHAT_ABORT,
        // 4th arg: companies/contacts the user attached via "+ Add context".
        // Empty/omitted → a plain single-meeting chat (byte-identical to before).
        buildInvokeArgs: ({ question, attachments }) => [
          k.meetingId,
          question,
          attachments,
          (k.refs ?? []).map((r) => ({ type: r.type, id: r.id })),
        ],
      }
    case 'meetings':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
        abort: IPC_CHANNELS.CHAT_ABORT_ALL,
        buildInvokeArgs: ({ question, attachments }) => [k.meetingIds, question, attachments],
      }
    case 'entities':
      return {
        query: IPC_CHANNELS.CHAT_QUERY_ENTITIES,
        abort: IPC_CHANNELS.CHAT_ABORT_ALL,
        buildInvokeArgs: ({ question, attachments }) => [
          {
            refs: k.refs.map((r) => ({ type: r.type, id: r.id })),
            question,
            attachments,
            contextId: k.contextId,
            contextKind: k.contextKind,
            contextLabel: k.contextLabel,
          },
        ],
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
