import { useEffect } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useChatStore } from '../stores/chat.store'

interface ActiveSession {
  id: string
  contextId: string
  title: string | null
}

interface PersistedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

/**
 * On contextId change, fetch the most-recent active session for this context
 * from the persisted store and populate the in-memory chat conversation if it's
 * empty. Does NOT overwrite an existing in-memory thread.
 */
export function useChatHydrate(contextId: string): void {
  const hydrateConversation = useChatStore((s) => s.hydrateConversation)
  const setSessionId = useChatStore((s) => s.setSessionId)

  useEffect(() => {
    if (!contextId) return
    let cancelled = false

    const existing = useChatStore.getState().conversations[contextId]
    if (existing && existing.messages.length > 0) {
      return
    }

    void (async () => {
      try {
        const session = await api.invoke<ActiveSession | null>(
          IPC_CHANNELS.CHAT_SESSION_GET_FOR_CONTEXT,
          contextId
        )
        if (cancelled || !session) return

        const messages = await api.invoke<PersistedMessage[]>(
          IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
          session.id
        )
        if (cancelled) return

        // Re-check after async — don't clobber a thread the user started in
        // the meantime.
        const current = useChatStore.getState().conversations[contextId]
        if (current && current.messages.length > 0) {
          setSessionId(contextId, session.id)
          return
        }

        hydrateConversation(
          contextId,
          session.id,
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
      } catch (err) {
        console.warn('[useChatHydrate] failed to hydrate', { contextId, err: String(err) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [contextId, hydrateConversation, setSessionId])
}
