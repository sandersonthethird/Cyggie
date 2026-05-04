import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../stores/chat.store'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import styles from './PanelHeader.module.css'

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
        <div className={styles.title} title={title}>{title}</div>
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
