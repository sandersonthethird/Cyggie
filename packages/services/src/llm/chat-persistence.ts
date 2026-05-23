// T17a — chat persistence now flows through the sync-wrapped barrel
// (writes emit outbox entries → Neon via Phase 1.5a SyncAgent). Reads use
// the same barrel for one-import simplicity.
import {
  appendChatMessage,
  createChatSession,
  getActiveChatSessionForContext,
  setChatSessionTitleIfMissing,
} from '@cyggie/db/sqlite/repositories'
import { generateChatTitle } from './chat-title'
import type { ChatContextKind } from '@shared/utils/chat-context'
import type { ChatAttachment } from '@shared/types/chat'

interface UserMessage {
  content: string
  attachments?: ChatAttachment[]
}

interface WithChatPersistenceOpts<T> {
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  userMessage: UserMessage
  runLLM: () => Promise<T>
  extractText: (response: T) => string
  userId: string | null
}

function isAbortError(err: unknown): boolean {
  if (!err) return false
  const msg = String(err)
  return msg.toLowerCase().includes('abort')
}

function attachmentsMetadataJson(attachments?: ChatAttachment[]): string | null {
  if (!attachments || attachments.length === 0) return null
  try {
    const meta = attachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      type: a.type,
    }))
    return JSON.stringify(meta)
  } catch {
    return null
  }
}

/**
 * Wraps a CHAT_QUERY_* handler with auto-persistence into chat_sessions.
 *
 *   1. Get-or-create the active session for this contextId.
 *   2. Persist the user turn (best-effort — log on failure, do not block).
 *   3. Run the LLM.
 *   4. Persist the assistant turn (best-effort).
 *   5. Fire-and-forget title generation if the session is still untitled.
 *
 * Persist failures NEVER block the user's chat experience. The LLM response is
 * always returned (or its error rethrown). Aborted streams are NOT persisted on
 * the assistant side (locked decision in eng review).
 */
export async function withChatPersistence<T>(
  opts: WithChatPersistenceOpts<T>
): Promise<T> {
  const { contextId, contextKind, contextLabel, userMessage, runLLM, extractText, userId } = opts

  let sessionId: string | null = null
  let sessionWasUntitled = false
  try {
    // T17a — getOrCreateActive is split into get-then-create so the create
    // path goes through the wrapped barrel (emits outbox). The existing
    // session case is a pure read; no outbox emission needed.
    let session = getActiveChatSessionForContext(contextId)
    if (!session) {
      session = createChatSession(contextId, contextKind, contextLabel, userId)
    }
    sessionId = session.id
    sessionWasUntitled = !session.title
  } catch (err) {
    console.error('[chat-persistence] failed to get/create session', {
      contextId,
      contextKind,
      err: String(err),
    })
  }

  if (sessionId) {
    try {
      appendChatMessage(
        {
          sessionId,
          role: 'user',
          content: userMessage.content,
          attachmentsJson: attachmentsMetadataJson(userMessage.attachments),
        },
        userId
      )
    } catch (err) {
      console.error('[chat-persistence] failed to append user message', {
        contextId,
        sessionId,
        err: String(err),
      })
    }
  }

  const response = await runLLM()

  if (sessionId) {
    let assistantText = ''
    try {
      assistantText = extractText(response)
    } catch (err) {
      console.error('[chat-persistence] extractText failed', { sessionId, err: String(err) })
    }

    if (assistantText) {
      try {
        appendChatMessage(
          { sessionId, role: 'assistant', content: assistantText },
          userId
        )
      } catch (err) {
        console.error('[chat-persistence] failed to append assistant message', {
          contextId,
          sessionId,
          err: String(err),
        })
      }
    }

    if (sessionWasUntitled && userMessage.content) {
      // Fire-and-forget title generation. Don't await; never let title-gen
      // errors interfere with the chat response.
      const transcript = `User: ${userMessage.content}\n\nAssistant: ${assistantText}`
      const fallback = userMessage.content.slice(0, 80)
      generateChatTitle(transcript, fallback)
        .then((title) => {
          if (sessionId && title) setChatSessionTitleIfMissing(sessionId, title)
        })
        .catch((err) => {
          console.warn('[chat-persistence] title generation failed', {
            sessionId,
            err: String(err),
          })
        })
    }
  }

  return response
}

/**
 * Variant for callers that already have a session (e.g., the modal continuing
 * a previously-loaded thread). Skips get-or-create; appends turns directly to
 * the given sessionId.
 */
export async function withSessionPersistence<T>(opts: {
  sessionId: string
  userMessage: UserMessage
  runLLM: () => Promise<T>
  extractText: (response: T) => string
  userId: string | null
}): Promise<T> {
  const { sessionId, userMessage, runLLM, extractText, userId } = opts

  try {
    appendChatMessage(
      {
        sessionId,
        role: 'user',
        content: userMessage.content,
        attachmentsJson: attachmentsMetadataJson(userMessage.attachments),
      },
      userId
    )
  } catch (err) {
    console.error('[chat-persistence] failed to append user message (session)', {
      sessionId,
      err: String(err),
    })
  }

  const response = await runLLM()

  let assistantText = ''
  try {
    assistantText = extractText(response)
  } catch (err) {
    console.error('[chat-persistence] extractText failed (session)', {
      sessionId,
      err: String(err),
    })
  }

  if (assistantText) {
    try {
      appendChatMessage(
        { sessionId, role: 'assistant', content: assistantText },
        userId
      )
    } catch (err) {
      console.error('[chat-persistence] failed to append assistant message (session)', {
        sessionId,
        err: String(err),
      })
    }
  }

  return response
}

export { isAbortError }
