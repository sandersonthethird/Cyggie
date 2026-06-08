import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api'
import { useRemoteApply } from '../../api/useRemoteApply'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import { useChatStore } from '../../stores/chat.store'
import { useChatStreaming } from '../../hooks/useChatStreaming'
import { deriveChatContext, type ChatContextKind } from '../../../shared/utils/chat-context'
import { stripContextIdPrefix } from '../../lib/context-id'
import { PanelThread } from './PanelThread'
import { PanelComposer } from './PanelComposer'
import { usePanelOutlet } from './PanelOutletContext'
import type { ChatKind } from '../../lib/chat-channels'
import type { ChatPageContext, ContextOption } from '../../../shared/types/chat'
import type { Note } from '../../../shared/types/note'

interface ActiveSession {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
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
 * Singleton mount + hydrate root for the AI chat panel.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  <ChatPanelRoot/>  (mounted once by Layout.tsx)               │
 *   │                                                               │
 *   │   on mount:                                                   │
 *   │     ──▶ if useChatPanelStore.openSessionId is set:            │
 *   │           load its messages, populate panelSession             │
 *   │     ──▶ else: leave empty, composer is still active           │
 *   │                                                               │
 *   │   render:                                                     │
 *   │     mountPointThread   ──portal──▶ <PanelThread/>             │
 *   │     mountPointComposer ──portal──▶ <PanelComposer/>           │
 *   │   (the actual children are rendered ONCE in this tree;        │
 *   │    Rail/Fullscreen just provide DOM nodes for portal targets) │
 *   │                                                               │
 *   │   when openSessionId changes:                                 │
 *   │     ──▶ load messages, replace panelSession                   │
 *   └──────────────────────────────────────────────────────────────┘
 */
export function ChatPanelRoot() {
  const openSessionId = useChatPanelStore((s) => s.openSessionId)
  const setOpenSessionId = useChatPanelStore((s) => s.setOpenSessionId)
  const setOpen = useChatPanelStore((s) => s.setOpen)
  const setMode = useChatPanelStore((s) => s.setMode)
  const setHasUnread = useChatPanelStore((s) => s.setHasUnread)
  const isOpen = useChatPanelStore((s) => s.isOpen)
  const popped = useChatPanelStore((s) => s.popped)
  const bumpAction = useChatPanelStore((s) => s.bumpAction)
  const { threadEl, composerEl } = usePanelOutlet()

  const panelSession = useChatStore((s) => s.panelSession)
  const loadPanelSession = useChatStore((s) => s.loadPanelSession)
  const appendPanelMessage = useChatStore((s) => s.appendPanelMessage)
  const pageContext = useChatStore((s) => s.pageContext)
  const dismissedContextChips = useChatPanelStore((s) => s.dismissedContextChips)

  const [error, setError] = useState<string | null>(null)
  const [activeContextId, setActiveContextId] = useState<string | null>(null)

  // ── Hydrate on mount ───────────────────────────────────────────────────
  // If lastChatId is in localStorage, load its messages. Otherwise fall
  // through to the globally-most-recent active session.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    void hydratePanelOnMount({
      lastChatId: openSessionId,
      onLoad: (s, msgs) => {
        loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, msgs)
      },
      onClearLastChatId: () => setOpenSessionId(null),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When openSessionId changes from a UI action (row click, new chat, deep link),
  // load that session's messages into panelSession. Skip when the in-memory
  // panelSession already matches (avoids a re-fetch on rerender).
  useEffect(() => {
    if (!openSessionId) return
    if (panelSession?.sessionId === openSessionId) return
    void loadSessionAndMessages(openSessionId, (s, msgs) => {
      loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, msgs)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId])

  // 2026-05-24 (Bug B) — reload the open session's messages when sync-pull
  // applies remote chat updates. Mobile-sent messages on the currently-
  // open session land in SQLite via pull; without this subscription the
  // panel keeps showing the old message list.
  useRemoteApply(IPC_CHANNELS.CHAT_SESSION_MESSAGES_REMOTE_APPLIED, () => {
    if (!openSessionId) return
    void loadSessionAndMessages(openSessionId, (s, msgs) => {
      loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, msgs)
    })
  })
  useRemoteApply(IPC_CHANNELS.CHAT_SESSIONS_REMOTE_APPLIED, (ids) => {
    if (openSessionId && ids.includes(openSessionId)) {
      void loadSessionAndMessages(openSessionId, (s, msgs) => {
        loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, msgs)
      })
    }
  })

  // Pick the active ContextOption to display in the chip.
  // - If panelSession has a contextId matching pageContext.contextOptions, use it.
  // - Else use pageContext.contextOptions[0] when present.
  const contextOptions: ContextOption[] = useMemo(() => pageContext?.contextOptions ?? [], [pageContext])
  useEffect(() => {
    if (contextOptions.length === 0) {
      setActiveContextId(null)
      return
    }
    setActiveContextId((prev) => {
      if (prev && contextOptions.some((o) => o.id === prev)) return prev
      return contextOptions[0].id
    })
  }, [contextOptions])

  const currentKind = useMemo<ChatKind>(
    () => deriveCurrentKind({
      contextOptions,
      activeContextId,
      panelSession,
      pageContext,
      dismissedContextChips,
    }),
    [contextOptions, activeContextId, panelSession, pageContext, dismissedContextChips]
  )

  // ── Streaming hook ────────────────────────────────────────────────────
  const { isLoading, streamedContent, send, abort } = useChatStreaming({
    onComplete: (full) => {
      appendPanelMessage({ role: 'assistant', content: full })
      bumpAction()
      // Surface unread when assistant message arrives while panel is closed.
      if (!isOpen) setHasUnread(true)
    },
    onAbortPartial: (partial) => {
      appendPanelMessage({ role: 'assistant', content: partial })
      bumpAction()
    },
    onError: (msg) => {
      setError(msg)
    },
  })

  // ── Composer actions ──────────────────────────────────────────────────
  const appendUser = useCallback(
    (content: string) => {
      appendPanelMessage({ role: 'user', content })
    },
    [appendPanelMessage]
  )

  const handleNewChat = useCallback(async () => {
    const ctx = deriveChatForNewChat(pageContext)
    try {
      const newSession = await api.invoke<{ id: string; contextId: string; contextKind: ChatContextKind; contextLabel: string | null; title: string | null }>(
        IPC_CHANNELS.CHAT_SESSION_CREATE_NEW,
        { contextId: ctx.contextId, contextKind: ctx.contextKind, contextLabel: ctx.contextLabel ?? null }
      )
      loadPanelSession(newSession.id, newSession.contextId, newSession.contextKind, newSession.contextLabel, [])
      setOpenSessionId(newSession.id)
      setMode('thread')
      bumpAction()
    } catch (err) {
      console.warn('[chat-panel] new chat failed', err)
      setError('Could not start a new chat. Please try again.')
    }
  }, [pageContext, loadPanelSession, setOpenSessionId, setMode, bumpAction])

  // Listen for "new chat" requests from the switcher's bottom input.
  useEffect(() => {
    const handler = () => void handleNewChat()
    window.addEventListener('cyggie:new-chat', handler as EventListener)
    return () => window.removeEventListener('cyggie:new-chat', handler as EventListener)
  }, [handleNewChat])

  // ── Save chat to Notes (overflow menu) ────────────────────────────────
  const handleSaveToNote = useCallback(async () => {
    if (!panelSession || panelSession.messages.length === 0) {
      setError('Nothing to save yet.')
      return
    }
    const transcript = panelSession.messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? '**You:**' : '**AI:**'}\n\n${m.content.trim()}`)
      .join('\n\n---\n\n')
    if (!transcript) {
      setError('Nothing to save yet.')
      return
    }
    try {
      const companyId = panelSession.contextKind === 'company' ? stripContextIdPrefix('company', panelSession.contextId) : null
      const contactId = panelSession.contextKind === 'contact' ? stripContextIdPrefix('contact', panelSession.contextId) : null
      await api.invoke<Note>(IPC_CHANNELS.CHAT_SAVE_AS_NOTE, {
        transcriptMarkdown: transcript,
        companyId,
        contactId,
        sourceMeetingId: panelSession.contextKind === 'meeting' ? panelSession.contextId : null,
      })
      bumpAction()
    } catch (err) {
      console.warn('[chat-panel] save-to-note failed', err)
      setError(`Couldn't save chat: ${String(err)}`)
    }
  }, [panelSession, bumpAction])

  useEffect(() => {
    const handler = () => void handleSaveToNote()
    window.addEventListener('cyggie:open-save-to-note', handler as EventListener)
    return () => window.removeEventListener('cyggie:open-save-to-note', handler as EventListener)
  }, [handleSaveToNote])

  // Adapter for context-chip selection (single-context model in v1: no persisted
  // kind change; the next message just routes through the selected entity).
  const handleContextChange = useCallback((option: ContextOption | null) => {
    setActiveContextId(option?.id ?? null)
  }, [])

  // Determine a context-aware placeholder. After the user dismisses the chip,
  // we drop entity-specific copy so the input clearly looks "global".
  const placeholder = useMemo(() => {
    const dismissed = panelSession ? dismissedContextChips.has(panelSession.sessionId) : false
    if (dismissed) return 'Ask Cyggie anything…'
    const selected = contextOptions.find((o) => o.id === activeContextId)
    if (selected) return `Ask Cyggie about ${selected.name}…`
    if (pageContext?.meetingId) return 'Ask Cyggie about this meeting…'
    return 'Ask Cyggie about this conversation…'
  }, [contextOptions, activeContextId, pageContext, panelSession, dismissedContextChips])

  // Skip rendering when the panel is fully closed AND not popped (no targets to portal into).
  // Keep rendering when isOpen=false but popped=true so the full-screen route can mount the targets.
  if (!isOpen && !popped) return null

  // Defensive null guard: portal target may not exist yet on first render before
  // the rail has mounted its slots. createPortal accepts a non-null Element only.
  return (
    <>
      {threadEl &&
        createPortal(
          <PanelThread
            isLoading={isLoading}
            streamedContent={streamedContent}
            large={popped}
          />,
          threadEl
        )}
      {composerEl &&
        createPortal(
          <PanelComposer
            kind={currentKind}
            contextOptions={contextOptions}
            activeContextId={activeContextId}
            onContextChange={handleContextChange}
            isLoading={isLoading}
            send={send}
            abort={abort}
            appendUser={appendUser}
            error={error}
            onClearError={() => setError(null)}
            onNewChat={() => void handleNewChat()}
            placeholder={placeholder}
            large={popped}
          />,
          composerEl
        )}
    </>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Pure function that maps the current panel state to a ChatKind for
 * useChatStreaming dispatch.
 *
 *   Priority:
 *     0. dismissed chip            → global  (user explicitly detached)
 *     1. explicit chip selection   → company / contact
 *     2. panelSession's persisted  → company / contact / meeting / global
 *     3. pageContext (no session)  → meeting / meetings
 *     4. fallback                  → global
 *
 * The dismissed-chip override is what the user gets after clicking × on the
 * "Including context: <Init Labs>" chip. Without this, a persisted session
 * created with company kind on a company page keeps routing through
 * COMPANY_CHAT_QUERY even after dismissal — which caused the
 * "Bobby Kwon couldn't be found" trap.
 *
 * Exported for tests; not consumed elsewhere.
 */
export function deriveCurrentKind(opts: {
  contextOptions: ContextOption[]
  activeContextId: string | null
  panelSession: { sessionId: string; contextId: string; contextKind: ChatContextKind } | null
  pageContext: ChatPageContext | null
  dismissedContextChips: Set<string>
}): ChatKind {
  const { contextOptions, activeContextId, panelSession, pageContext, dismissedContextChips } = opts

  const dismissed = panelSession ? dismissedContextChips.has(panelSession.sessionId) : false
  if (dismissed) return { kind: 'global' }

  const selected = contextOptions.find((o) => o.id === activeContextId)
  if (selected) {
    return selected.type === 'company'
      ? { kind: 'company', companyId: selected.id }
      : { kind: 'contact', contactId: selected.id }
  }
  if (panelSession) {
    switch (panelSession.contextKind) {
      case 'company': return { kind: 'company', companyId: stripContextIdPrefix('company', panelSession.contextId) }
      case 'contact': return { kind: 'contact', contactId: stripContextIdPrefix('contact', panelSession.contextId) }
      case 'meeting': return { kind: 'meeting', meetingId: panelSession.contextId }
      case 'global':
      default:        return { kind: 'global' }
    }
  }
  if (pageContext?.meetingId) return { kind: 'meeting', meetingId: pageContext.meetingId }
  if (pageContext?.meetingIds?.length) return { kind: 'meetings', meetingIds: pageContext.meetingIds }
  return { kind: 'global' }
}


async function hydratePanelOnMount(opts: {
  lastChatId: string | null
  onLoad: (session: ActiveSession, messages: { role: 'user' | 'assistant' | 'system'; content: string }[]) => void
  onClearLastChatId: () => void
}) {
  const start = Date.now()
  try {
    if (opts.lastChatId) {
      try {
        const messages = await api.invoke<PersistedMessage[]>(
          IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
          opts.lastChatId
        )
        // We don't have the session metadata cached here — derive a minimal
        // ActiveSession from the recents list so contextKind/Label are right.
        const recents = await api.invoke<{ id: string; contextId: string; contextKind: ChatContextKind; contextLabel: string | null; title: string | null }[]>(
          IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
          { limit: 100 }
        )
        const match = recents.find((r) => r.id === opts.lastChatId)
        if (!match) {
          opts.onClearLastChatId()
          // Fall through: try the most-recent.
          if (recents.length > 0) {
            const top = recents[0]
            const topMsgs = await api.invoke<PersistedMessage[]>(IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES, top.id)
            opts.onLoad(
              { id: top.id, contextId: top.contextId, contextKind: top.contextKind, contextLabel: top.contextLabel, title: top.title },
              topMsgs.map((m) => ({ role: m.role, content: m.content }))
            )
          }
          console.info('[chat-panel] hydrated', { ms: Date.now() - start, lastChatId: null, fallback: 'recent-or-empty' })
          return
        }
        opts.onLoad(
          { id: match.id, contextId: match.contextId, contextKind: match.contextKind, contextLabel: match.contextLabel, title: match.title },
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
        console.info('[chat-panel] hydrated', { ms: Date.now() - start, lastChatId: match.id })
        return
      } catch (err) {
        console.warn('[chat-panel] hydrate from lastChatId failed', err)
      }
    }
    // No lastChatId or it failed — load most-recent.
    const recents = await api.invoke<{ id: string; contextId: string; contextKind: ChatContextKind; contextLabel: string | null; title: string | null }[]>(
      IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
      { limit: 1 }
    )
    if (recents.length > 0) {
      const top = recents[0]
      const topMsgs = await api.invoke<PersistedMessage[]>(IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES, top.id)
      opts.onLoad(
        { id: top.id, contextId: top.contextId, contextKind: top.contextKind, contextLabel: top.contextLabel, title: top.title },
        topMsgs.map((m) => ({ role: m.role, content: m.content }))
      )
      console.info('[chat-panel] hydrated', { ms: Date.now() - start, lastChatId: top.id, fallback: 'most-recent' })
    } else {
      console.info('[chat-panel] hydrated empty', { ms: Date.now() - start })
    }
  } catch (err) {
    console.warn('[chat-panel] hydrate failed', err)
  }
}

async function loadSessionAndMessages(
  sessionId: string,
  onLoad: (session: ActiveSession, messages: { role: 'user' | 'assistant' | 'system'; content: string }[]) => void
) {
  try {
    const [recents, messages] = await Promise.all([
      api.invoke<{ id: string; contextId: string; contextKind: ChatContextKind; contextLabel: string | null; title: string | null }[]>(
        IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
        { limit: 100 }
      ),
      api.invoke<PersistedMessage[]>(IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES, sessionId),
    ])
    const match = recents.find((r) => r.id === sessionId)
    if (!match) {
      console.warn('[chat-panel] session not in recents', sessionId)
      return
    }
    onLoad(
      { id: match.id, contextId: match.contextId, contextKind: match.contextKind, contextLabel: match.contextLabel, title: match.title },
      messages.map((m) => ({ role: m.role, content: m.content }))
    )
  } catch (err) {
    console.warn('[chat-panel] load session failed', err)
  }
}

function deriveChatForNewChat(pageContext: ChatPageContext | null): {
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
} {
  if (!pageContext) {
    const ctx = deriveChatContext({})
    return { contextId: ctx?.contextId ?? 'global-all', contextKind: ctx?.kind ?? 'global', contextLabel: null }
  }
  const opt = pageContext.contextOptions?.[0]
  if (opt) {
    const ctx = deriveChatContext({
      companyId: opt.type === 'company' ? opt.id : undefined,
      contactId: opt.type === 'contact' ? opt.id : undefined,
    })
    return { contextId: ctx?.contextId ?? 'global-all', contextKind: ctx?.kind ?? 'global', contextLabel: opt.name }
  }
  if (pageContext.meetingId) {
    return { contextId: pageContext.meetingId, contextKind: 'meeting', contextLabel: null }
  }
  const ctx = deriveChatContext({})
  return { contextId: ctx?.contextId ?? 'global-all', contextKind: ctx?.kind ?? 'global', contextLabel: null }
}
