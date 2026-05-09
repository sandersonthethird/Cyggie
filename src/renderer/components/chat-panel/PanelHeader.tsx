import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../../stores/chat.store'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import type { ChatContextKind } from '../../../shared/utils/chat-context'
import styles from './PanelHeader.module.css'

/**
 * Map a panelSession's (contextKind, contextId) tuple to the route of the
 * entity's detail page. Returns null for global chats (no destination) or
 * when the session hasn't hydrated yet. Prefix-stripping mirrors the scheme
 * baked in by deriveChatContext (shared/utils/chat-context.ts).
 */
function destinationFor(
  kind: ChatContextKind | undefined,
  contextId: string | undefined,
): string | null {
  if (!kind || !contextId) return null
  if (kind === 'company') return `/company/${contextId.replace(/^company:/, '')}`
  if (kind === 'contact') return `/contact/${contextId.replace(/^contact:/, '')}`
  if (kind === 'meeting') return `/meeting/${contextId}`
  return null
}

interface PanelHeaderProps {
  /** Click pop-out → navigate to /ai-chats/:id, set popped=true. */
  onPopOut: () => void
  /** Click close → store.setOpen(false). */
  onClose: () => void
  /** Click menu → switch mode to 'switcher' (or back to 'thread'). */
  onToggleSwitcher: () => void
  /** Click "Save to note…" → opens the picker (handled by parent). */
  onSaveToNote?: () => void
  mode: 'thread' | 'switcher'
  totalChats: number
}

export function PanelHeader({ onPopOut, onClose, onToggleSwitcher, onSaveToNote, mode, totalChats }: PanelHeaderProps) {
  const panelSession = useChatStore((s) => s.panelSession)
  const navigate = useNavigate()
  const popped = useChatPanelStore((s) => s.popped)
  const setPopped = useChatPanelStore((s) => s.setPopped)
  const setOpen = useChatPanelStore((s) => s.setOpen)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!overflowOpen) return
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [overflowOpen])

  if (mode === 'switcher') {
    return (
      <div className={styles.head}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onToggleSwitcher}
          title="Back to current chat"
          aria-label="Back to current chat"
        >
          ←
        </button>
        <div className={styles.titleWrap}>
          <div className={styles.title}>All chats</div>
          <div className={styles.meta}>
            {totalChats} conversation{totalChats === 1 ? '' : 's'}
          </div>
        </div>
        <button type="button" className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close panel">
          ×
        </button>
      </div>
    )
  }

  const title = panelSession ? (panelSession.contextLabel ?? 'Chat') : 'AI Chat'
  const messageCount = panelSession?.messages.length ?? 0
  const dest = destinationFor(panelSession?.contextKind, panelSession?.contextId)

  function goToEntity() {
    if (!dest) return
    // When popped to full-screen, also collapse the panel back to the rail
    // so the user actually sees the destination page underneath.
    if (popped) {
      setPopped(false)
      setOpen(true)
    }
    navigate(dest)
  }

  return (
    <div className={styles.head}>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={onToggleSwitcher}
        title="All chats"
        aria-label="All chats"
      >
        ☰
      </button>
      <div className={styles.titleWrap}>
        {dest ? (
          <button
            type="button"
            className={`${styles.title} ${styles.titleLink}`}
            title={title}
            aria-label={`Open ${title} detail`}
            onClick={goToEntity}
          >
            {title}
          </button>
        ) : (
          <div className={styles.title} title={title}>{title}</div>
        )}
        <div className={styles.meta}>
          {messageCount > 0 ? `${messageCount} message${messageCount === 1 ? '' : 's'}` : 'New chat'}
        </div>
      </div>
      <div className={styles.actions}>
        {onSaveToNote && panelSession && (
          <div className={styles.overflowWrap} ref={overflowRef}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setOverflowOpen((v) => !v)}
              title="More"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
            >
              ⋯
            </button>
            {overflowOpen && (
              <div className={styles.overflowMenu} role="menu">
                <button
                  type="button"
                  className={styles.overflowItem}
                  onClick={() => {
                    setOverflowOpen(false)
                    onSaveToNote()
                  }}
                >
                  Save to note…
                </button>
              </div>
            )}
          </div>
        )}
        <button type="button" className={styles.iconBtn} onClick={onPopOut} title="Open full screen" aria-label="Open full screen">
          ⤢
        </button>
        <button type="button" className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close panel">
          ×
        </button>
      </div>
    </div>
  )
}
