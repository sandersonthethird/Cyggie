import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { type EntityRef } from '@cyggie/services/llm/entities-chat'
import { chatDispatch } from '@cyggie/services/llm/chat-dispatch'
import { withChatPersistence } from '@cyggie/services/llm/chat-persistence'
import { withProgressSink } from '@cyggie/services/llm/send-progress'
import { createChatProgressSink } from '../lib/ipc-progress-sink'
import { getCurrentUserId } from '../security/current-user'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import type { ChatAttachment, AttachedContextEntity } from '../../shared/types/chat'
import type { ChatContextKind } from '../../shared/utils/chat-context'

/** Resolved availability + fresh label for one attached entity. */
interface ResolvedAttachedEntity extends AttachedContextEntity {
  available: boolean
}

function resolveEntity(e: AttachedContextEntity): ResolvedAttachedEntity {
  const db = getDatabase()
  if (e.type === 'company') {
    const row = db.prepare(`SELECT canonical_name FROM org_companies WHERE id = ?`).get(e.id) as
      | { canonical_name: string }
      | undefined
    return { ...e, available: !!row, label: row?.canonical_name ?? e.label }
  }
  const row = db.prepare(`SELECT full_name FROM contacts WHERE id = ?`).get(e.id) as
    | { full_name: string | null }
    | undefined
  return { ...e, available: !!row, label: row?.full_name ?? e.label }
}

/**
 * Multi-entity chat (CHAT_QUERY_ENTITIES). The renderer routes every chat with
 * 1+ attached company/contact through here; queryEntities reuses the
 * single-entity builder for the N=1 case and a deduped union builder for N≥2.
 *
 * Persistence anchors on the OPEN session's own contextId/contextKind (passed
 * from the renderer) — the attached-entity list overrides routing but never
 * changes the session row's identity. Abort reuses the shared single
 * AbortController via abortEntitiesChat → abortChatTurn.
 */
export function registerEntitiesChatHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_QUERY_ENTITIES,
    async (
      _event,
      data: {
        refs: EntityRef[]
        question: string
        attachments?: ChatAttachment[]
        contextId: string
        contextKind: ChatContextKind
        contextLabel?: string | null
      },
    ) => {
      if (!data?.question?.trim()) throw new Error('question is required')
      if (!data?.contextId) throw new Error('contextId is required')
      const refs = (data.refs ?? []).filter(
        (r): r is EntityRef => !!r && (r.type === 'company' || r.type === 'contact') && !!r.id,
      )

      return withChatPersistence({
        contextId: data.contextId,
        contextKind: data.contextKind,
        contextLabel: data.contextLabel ?? null,
        userMessage: { content: data.question.trim(), attachments: data.attachments },
        userId: getCurrentUserId(),
        runLLM: () =>
          withProgressSink(createChatProgressSink(), () =>
            chatDispatch({
              kind: { kind: 'entities', refs },
              question: data.question.trim(),
              attachments: data.attachments,
            }),
          ),
        extractText: (response: string) => response,
      })
    },
  )

  // Resolve attached-entity availability + fresh labels for the chip row. Used
  // to grey out chips whose company/contact was deleted (the context builder
  // independently skips them — see queryEntities).
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESOLVE_ATTACHED_ENTITIES,
    (_event, entities: AttachedContextEntity[]): ResolvedAttachedEntity[] => {
      const valid = (entities ?? []).filter(
        (e) => e && (e.type === 'company' || e.type === 'contact') && e.id,
      )
      return valid.map(resolveEntity)
    },
  )

  // Abort routes through the shared single-controller path (CHAT_ABORT_ALL is
  // also wired in crm-chat.ipc.ts; both call abortChatTurn — idempotent).
}
