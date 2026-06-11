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
import type { ChatPageContext, ContextOption, AttachedContextEntity } from '../../../shared/types/chat'
import type { Note } from '../../../shared/types/note'

interface ActiveSession {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  attachedContextEntities: AttachedContextEntity[]
}

/** Shape returned by CHAT_SESSION_LIST_RECENT (subset of ChatSession). */
interface RecentSessionRow {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  attachedContextEntities: AttachedContextEntity[]
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
  const setPanelAttachedEntities = useChatStore((s) => s.setPanelAttachedEntities)
  const appendPanelMessage = useChatStore((s) => s.appendPanelMessage)
  const pageContext = useChatStore((s) => s.pageContext)

  const [error, setError] = useState<string | null>(null)

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
        loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, s.attachedContextEntities ?? [], msgs)
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
      loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, s.attachedContextEntities ?? [], msgs)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionId])

  // 2026-05-24 (Bug B) — reload the open session's messages when sync-pull
  // applies remote chat updates. Mobile-sent messages on the currently-
  // open session land in SQLite via pull; without this subscription the
  // panel keeps showing the old message list.
  //
  // IMPORTANT: a remote apply for the CURRENTLY-OPEN session must NOT reset its
  // attached-context chips. The desktop re-pulls its own just-written session
  // row on a sync tick (the local lamport isn't stamped, so the row looks
  // "older" than Neon); if that pull hits the apply INSERT branch the row's
  // attached_context_entities defaults to '[]', and reloading from it would
  // wipe the user's chips mid-chat. The in-memory list is authoritative for the
  // open chat's UI, so preserve it; only adopt the DB value for a *different*
  // session. See sync-remote-apply.ts upsertChatSessionRow for the data-layer
  // defense.
  const reloadOpenSession = useCallback(() => {
    if (!openSessionId) return
    void loadSessionAndMessages(openSessionId, (s, msgs) => {
      const current = useChatStore.getState().panelSession
      const entities =
        current && current.sessionId === s.id
          ? current.attachedEntities
          : s.attachedContextEntities ?? []
      loadPanelSession(s.id, s.contextId, s.contextKind, s.contextLabel, entities, msgs)
    })
  }, [openSessionId, loadPanelSession])

  useRemoteApply(IPC_CHANNELS.CHAT_SESSION_MESSAGES_REMOTE_APPLIED, reloadOpenSession)
  useRemoteApply(IPC_CHANNELS.CHAT_SESSIONS_REMOTE_APPLIED, (ids) => {
    if (openSessionId && ids.includes(openSessionId)) reloadOpenSession()
  })

  const currentKind = useMemo<ChatKind>(
    () => deriveCurrentKind({ panelSession, pageContext }),
    [panelSession, pageContext]
  )

  // The chips shown above the composer come from the persisted attached-entity
  // list (or, before a session exists, the entities the next message will use).
  const attachedEntities = useMemo<AttachedContextEntity[]>(
    () => (currentKind.kind === 'entities' ? currentKind.refs : []),
    [currentKind]
  )

  // Persist a new attached-entity list and mirror it into the in-memory panel
  // session so the chips + routing update immediately. Requires an existing
  // session (the chip row only renders once one is open).
  const persistAttachedEntities = useCallback(
    async (next: AttachedContextEntity[]) => {
      const sessionId = panelSession?.sessionId
      if (!sessionId) return
      setPanelAttachedEntities(next)
      bumpAction()
      try {
        await api.invoke(IPC_CHANNELS.CHAT_SESSION_SET_ATTACHED_ENTITIES, { sessionId, entities: next })
      } catch (err) {
        console.warn('[chat-panel] persist attached entities failed', err)
      }
    },
    [panelSession?.sessionId, setPanelAttachedEntities, bumpAction]
  )

  const handleAddEntity = useCallback(
    (entity: AttachedContextEntity) => {
      const current = panelSession?.attachedEntities ?? attachedEntities
      if (current.some((e) => e.type === entity.type && e.id === entity.id)) return
      void persistAttachedEntities([...current, entity])
    },
    [panelSession?.attachedEntities, attachedEntities, persistAttachedEntities]
  )

  const handleRemoveEntity = useCallback(
    (entity: AttachedContextEntity) => {
      const current = panelSession?.attachedEntities ?? attachedEntities
      void persistAttachedEntities(current.filter((e) => !(e.type === entity.type && e.id === entity.id)))
    },
    [panelSession?.attachedEntities, attachedEntities, persistAttachedEntities]
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
    // Seed the attached-entity list from the page's primary entity so a chat
    // opened from a company/contact page starts with that context chip.
    const seedEntities: AttachedContextEntity[] = (pageContext?.contextOptions ?? []).map((o) => ({
      type: o.type,
      id: o.id,
      label: o.name,
    }))
    try {
      const newSession = await api.invoke<RecentSessionRow>(
        IPC_CHANNELS.CHAT_SESSION_CREATE_NEW,
        {
          contextId: ctx.contextId,
          contextKind: ctx.contextKind,
          contextLabel: ctx.contextLabel ?? null,
          attachedContextEntities: seedEntities,
        }
      )
      loadPanelSession(
        newSession.id,
        newSession.contextId,
        newSession.contextKind,
        newSession.contextLabel,
        newSession.attachedContextEntities ?? seedEntities,
        []
      )
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
      // Link the saved note to the chat's attached entities. The session's
      // contextId/contextKind is the anchor, but multi-entity chats live on a
      // 'global'/seeded anchor — so prefer the first attached company/contact.
      const firstCompany = panelSession.attachedEntities.find((e) => e.type === 'company')
      const firstContact = panelSession.attachedEntities.find((e) => e.type === 'contact')
      const companyId =
        firstCompany?.id ??
        (panelSession.contextKind === 'company' ? stripContextIdPrefix('company', panelSession.contextId) : null)
      const contactId =
        firstContact?.id ??
        (panelSession.contextKind === 'contact' ? stripContextIdPrefix('contact', panelSession.contextId) : null)
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

  // Context-aware placeholder driven by the attached-entity list.
  const placeholder = useMemo(() => {
    if (attachedEntities.length === 1) return `Ask Cyggie about ${attachedEntities[0].label}…`
    if (attachedEntities.length > 1) return `Ask Cyggie about these ${attachedEntities.length} items…`
    if (currentKind.kind === 'meeting') return 'Ask Cyggie about this meeting…'
    if (currentKind.kind === 'global') return 'Ask Cyggie anything…'
    return 'Ask Cyggie about this conversation…'
  }, [attachedEntities, currentKind])

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
            attachedEntities={attachedEntities}
            canAttach={panelSession != null && currentKind.kind !== 'meeting' && currentKind.kind !== 'meetings'}
            onAddEntity={handleAddEntity}
            onRemoveEntity={handleRemoveEntity}
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
 *   Priority (unified multi-entity model):
 *     panelSession exists:
 *       • contextKind 'meeting'      → meeting
 *       • attachedEntities ≥ 1       → entities (deduped multi-entity context)
 *       • attachedEntities empty     → global  (user removed all context)
 *     no panelSession (fresh page):
 *       • pageContext.contextOptions → entities (seeded from the page entity)
 *       • pageContext.meetingId      → meeting
 *       • pageContext.meetingIds     → meetings
 *       • fallback                   → global
 *
 * The persisted attachedEntities list overrides routing but NEVER changes the
 * session row's contextId/contextKind — those stay the anchor the chat
 * messages persist under. Removing every chip yields the empty-list → global
 * state (this replaced the old transient "dismissed chip" hack).
 *
 * Exported for tests; not consumed elsewhere.
 */
export function deriveCurrentKind(opts: {
  panelSession: {
    sessionId: string
    contextId: string
    contextKind: ChatContextKind
    contextLabel: string | null
    attachedEntities: AttachedContextEntity[]
  } | null
  pageContext: ChatPageContext | null
}): ChatKind {
  const { panelSession, pageContext } = opts

  if (panelSession) {
    if (panelSession.contextKind === 'meeting') {
      return { kind: 'meeting', meetingId: panelSession.contextId }
    }
    if (panelSession.attachedEntities.length >= 1) {
      return {
        kind: 'entities',
        refs: panelSession.attachedEntities,
        contextId: panelSession.contextId,
        contextKind: panelSession.contextKind,
        contextLabel: panelSession.contextLabel,
      }
    }
    return { kind: 'global' }
  }

  // No session yet — seed routing from the current page.
  const pageEntities: AttachedContextEntity[] = (pageContext?.contextOptions ?? []).map((o) => ({
    type: o.type,
    id: o.id,
    label: o.name,
  }))
  if (pageEntities.length >= 1) {
    const primary = pageEntities[0]
    const ctx = deriveChatContext({
      companyId: primary.type === 'company' ? primary.id : undefined,
      contactId: primary.type === 'contact' ? primary.id : undefined,
    })
    return {
      kind: 'entities',
      refs: pageEntities,
      contextId: ctx?.contextId ?? 'global-all',
      contextKind: ctx?.kind ?? 'global',
      contextLabel: primary.label,
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
        const recents = await api.invoke<RecentSessionRow[]>(
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
              { id: top.id, contextId: top.contextId, contextKind: top.contextKind, contextLabel: top.contextLabel, title: top.title, attachedContextEntities: top.attachedContextEntities ?? [] },
              topMsgs.map((m) => ({ role: m.role, content: m.content }))
            )
          }
          console.info('[chat-panel] hydrated', { ms: Date.now() - start, lastChatId: null, fallback: 'recent-or-empty' })
          return
        }
        opts.onLoad(
          { id: match.id, contextId: match.contextId, contextKind: match.contextKind, contextLabel: match.contextLabel, title: match.title, attachedContextEntities: match.attachedContextEntities ?? [] },
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
        console.info('[chat-panel] hydrated', { ms: Date.now() - start, lastChatId: match.id })
        return
      } catch (err) {
        console.warn('[chat-panel] hydrate from lastChatId failed', err)
      }
    }
    // No lastChatId or it failed — load most-recent.
    const recents = await api.invoke<RecentSessionRow[]>(
      IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
      { limit: 1 }
    )
    if (recents.length > 0) {
      const top = recents[0]
      const topMsgs = await api.invoke<PersistedMessage[]>(IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES, top.id)
      opts.onLoad(
        { id: top.id, contextId: top.contextId, contextKind: top.contextKind, contextLabel: top.contextLabel, title: top.title, attachedContextEntities: top.attachedContextEntities ?? [] },
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
      api.invoke<RecentSessionRow[]>(
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
      { id: match.id, contextId: match.contextId, contextKind: match.contextKind, contextLabel: match.contextLabel, title: match.title, attachedContextEntities: match.attachedContextEntities ?? [] },
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
