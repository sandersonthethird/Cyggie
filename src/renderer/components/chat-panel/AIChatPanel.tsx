import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import { useChatActions, type ChatSessionRow } from '../../hooks/useChatActions'
import { PanelHeader } from './PanelHeader'
import { PanelSwitcher } from './PanelSwitcher'
import { ResizeHandle } from './ResizeHandle'
import { usePanelOutlet } from './PanelOutletContext'
import styles from './AIChatPanel.module.css'

interface AIChatPanelProps {
  /** Caller (Layout) decides whether to render at all (skipped when closed). */
  /** True when below the mobile breakpoint — switches to overlay layout. */
  overlay: boolean
  /** Callback to dismiss the overlay backdrop tap. */
  onBackdropTap?: () => void
}

/**
 * The right-rail chat panel.
 *
 *   ┌───────────────────────────────────┐
 *   │ PanelHeader  (back/menu, title,    │
 *   │              pop-out, close)       │
 *   ├───────────────────────────────────┤
 *   │  thread mode: <div mountPointThread> ← portal target
 *   │  switcher mode: <PanelSwitcher/>     │
 *   ├───────────────────────────────────┤
 *   │  thread mode: <div mountPointComposer> ← portal target
 *   │  switcher mode: (PanelSwitcher's bottom input)
 *   └───────────────────────────────────┘
 *   ResizeHandle on left edge (hidden in overlay mode).
 *
 * The actual <PanelThread/> + <PanelComposer/> live in <ChatPanelRoot/> and
 * portal into the slots registered here via setMountPoint*.
 */
export function AIChatPanel({ overlay, onBackdropTap }: AIChatPanelProps) {
  const navigate = useNavigate()
  const mode = useChatPanelStore((s) => s.mode)
  const setMode = useChatPanelStore((s) => s.setMode)
  const setOpen = useChatPanelStore((s) => s.setOpen)
  const setPopped = useChatPanelStore((s) => s.setPopped)
  const setReturnTo = useChatPanelStore((s) => s.setReturnTo)
  const setOpenSessionId = useChatPanelStore((s) => s.setOpenSessionId)
  const openSessionId = useChatPanelStore((s) => s.openSessionId)
  const lastActionAt = useChatPanelStore((s) => s.lastActionAt)
  const bumpAction = useChatPanelStore((s) => s.bumpAction)
  const { setThreadEl, setComposerEl } = usePanelOutlet()

  // Recents list for switcher mode + the open-session row highlight.
  const [sessions, setSessions] = useState<ChatSessionRow[]>([])
  const [recentsLoading, setRecentsLoading] = useState(false)
  const [totalChats, setTotalChats] = useState(0)
  const actions = useChatActions()

  const fetchRecents = useCallback(async () => {
    setRecentsLoading(true)
    try {
      const rows = await api.invoke<ChatSessionRow[]>(IPC_CHANNELS.CHAT_SESSION_LIST_RECENT, { limit: 100 })
      setSessions(rows)
    } catch (err) {
      console.warn('[chat-panel] list recent failed', err)
    } finally {
      setRecentsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRecents()
  }, [fetchRecents, lastActionAt])

  const handlePopOut = useCallback(() => {
    if (!openSessionId) return
    setReturnTo(window.location.hash.replace(/^#/, '') || '/')
    // popped=true alone removes the rail from Layout's render
    // (useReflow = isOpen && !popped). Keeping isOpen=true means
    // AIChatFullscreen's mount effect doesn't have to flip it back.
    setPopped(true)
    navigate(`/ai-chats/${openSessionId}`)
  }, [openSessionId, setReturnTo, setPopped, navigate])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [setOpen])

  const handleToggleSwitcher = useCallback(() => {
    setMode(mode === 'switcher' ? 'thread' : 'switcher')
  }, [mode, setMode])

  const handleSelectSession = useCallback(
    (id: string) => {
      setOpenSessionId(id)
      setMode('thread')
    },
    [setOpenSessionId, setMode]
  )

  const handleNewChatFromSwitcher = useCallback(
    async (initialQuery?: string) => {
      // Defer to ChatPanelRoot's onNewChat through a custom event — keeps the
      // creation logic in one place. The composer will pre-fill if initialQuery
      // is provided and start the conversation on Enter.
      window.dispatchEvent(
        new CustomEvent('cyggie:new-chat', { detail: { initialQuery: initialQuery ?? '' } })
      )
      setMode('thread')
    },
    [setMode]
  )

  const handleSaveToNote = useCallback(() => {
    window.dispatchEvent(new CustomEvent('cyggie:open-save-to-note'))
  }, [])

  // Optimistic mutation handlers. Used by future rich row affordances; left
  // here so the next iteration can wire up pin/archive/delete in the panel
  // switcher without further refactor.
  const handlePin = useCallback(
    async (id: string) => {
      const prev = sessions
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, isPinned: true } : s)))
      try {
        await actions.pin(id)
        bumpAction()
      } catch (err) {
        console.warn('[chat-panel] pin failed', err)
        setSessions(prev)
      }
    },
    [sessions, actions, bumpAction]
  )
  void handlePin // exposed for future rich rows

  return (
    <>
      {overlay && <div className={styles.backdrop} onClick={onBackdropTap} aria-hidden />}
      <aside
        className={`${styles.panel} ${overlay ? styles.panelOverlay : ''}`}
        aria-label="AI Chat panel"
      >
        {!overlay && <ResizeHandle />}
        <PanelHeader
          mode={mode}
          totalChats={totalChats}
          onPopOut={handlePopOut}
          onClose={handleClose}
          onToggleSwitcher={handleToggleSwitcher}
          onSaveToNote={handleSaveToNote}
        />
        {mode === 'switcher' ? (
          <PanelSwitcher
            sessions={sessions}
            loading={recentsLoading}
            onSelectSession={handleSelectSession}
            onNewChat={(q) => void handleNewChatFromSwitcher(q)}
            onSetTotalChats={setTotalChats}
          />
        ) : (
          <>
            <div className={styles.threadSlot} ref={setThreadEl} />
            <div className={styles.composerSlot} ref={setComposerEl} />
          </>
        )}
      </aside>
    </>
  )
}
