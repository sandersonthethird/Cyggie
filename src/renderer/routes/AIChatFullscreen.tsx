import { useEffect } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { useChatPanelStore } from '../stores/chat-panel.store'
import { useChatStore } from '../stores/chat.store'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { usePanelOutlet } from '../components/chat-panel/PanelOutletContext'
import styles from './AIChatFullscreen.module.css'

/**
 * /ai-chats/:id — dedicated full-width chat surface.
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ Cyggie / AI Chats / <chat title>     [Minimize]   │
 *   ├──────────────────────────────────────────────────┤
 *   │                                                   │
 *   │      <div mountPointThread/>     ← portal target  │
 *   │                                                   │
 *   ├──────────────────────────────────────────────────┤
 *   │      <div mountPointComposer/>   ← portal target  │
 *   └──────────────────────────────────────────────────┘
 *
 * Mount sequence:
 *   1. setPopped(true), setOpen(true)
 *   2. setOpenSessionId(params.id)  ← chatPanelRoot's effect loads messages
 *   3. setReturnTo(location.state.returnTo ?? '/')
 *   4. The slot div refs register with the store; <ChatPanelRoot/> portals
 *      <PanelThread/> + <PanelComposer/> into them — same DOM as the rail
 *      so scroll position, draft, and in-flight subscription survive.
 */
export default function AIChatFullscreen() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const location = useLocation()

  const setPopped = useChatPanelStore((s) => s.setPopped)
  const setOpen = useChatPanelStore((s) => s.setOpen)
  const setReturnTo = useChatPanelStore((s) => s.setReturnTo)
  const returnTo = useChatPanelStore((s) => s.returnTo)
  const setOpenSessionId = useChatPanelStore((s) => s.setOpenSessionId)
  const openSessionId = useChatPanelStore((s) => s.openSessionId)
  const panelSession = useChatStore((s) => s.panelSession)
  const { setThreadEl, setComposerEl } = usePanelOutlet()

  // Mount: set popped state, sync openSessionId from URL, capture returnTo
  // (don't overwrite an existing returnTo from a previous pop-out).
  useEffect(() => {
    setPopped(true)
    setOpen(true)
    if (id && id !== openSessionId) setOpenSessionId(id)
    // Use existing returnTo if set; otherwise fall back to location.state or root.
    const stateReturnTo = (location.state as { returnTo?: string } | null)?.returnTo
    if (!returnTo && stateReturnTo) setReturnTo(stateReturnTo)
    return () => {
      // On unmount (user navigates away by any means), reset popped so the rail
      // is willing to reopen on the next ⌘J.
      setPopped(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Cross-1024px-while-popped: when the viewport drops below 1024px while the
  // user is on the full-screen route, dock back to the (now-overlay) rail.
  // Otherwise the full-screen layout is too tight on narrow screens.
  const isNarrow = useMediaQuery('(max-width: 1024px)')
  useEffect(() => {
    if (isNarrow) {
      setPopped(false)
      setOpen(true)
      navigate(returnTo ?? '/')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNarrow])

  const handleMinimize = () => {
    setPopped(false)
    setOpen(true)
    navigate(returnTo ?? '/')
  }

  const title = panelSession?.contextLabel ?? 'Chat'

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.breadcrumb}>
          <span className={styles.breadcrumbHome}>Cyggie</span>
          <span className={styles.breadcrumbSep}>/</span>
          <button type="button" className={styles.breadcrumbLink} onClick={() => navigate('/ai-chats')}>
            AI Chats
          </button>
          <span className={styles.breadcrumbSep}>/</span>
          <span className={styles.breadcrumbCurrent}>{title}</span>
        </div>
        <button type="button" className={styles.minimizeBtn} onClick={handleMinimize}>
          Minimize to panel
        </button>
      </div>

      <div className={styles.column}>
        <div className={styles.threadSlot} ref={setThreadEl} />
        <div className={styles.composerSlot} ref={setComposerEl} />
      </div>
    </div>
  )
}
