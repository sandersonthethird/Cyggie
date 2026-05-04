import { useChatPanelStore } from '../../stores/chat-panel.store'
import styles from './ChatToggle.module.css'

const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
const KBD_HINT = isMac ? '⌘J' : 'Ctrl+J'

interface ChatToggleProps {
  onClick?: () => void
}

/**
 * Persistent titlebar entry-point for the AI chat panel.
 *
 *   Idle           outline button + swan glyph + "AI Chat"
 *   Unread (closed) red dot in upper-right
 *   Hover/focus    surfaces ⌘J / Ctrl+J kbd hint
 *   Active (open)  filled crimson, white text
 */
export function ChatToggle({ onClick }: ChatToggleProps) {
  const isOpen = useChatPanelStore((s) => s.isOpen)
  const hasUnread = useChatPanelStore((s) => s.hasUnread)
  const toggleOpen = useChatPanelStore((s) => s.toggleOpen)

  const handleClick = () => {
    if (onClick) onClick()
    else toggleOpen()
  }

  return (
    <button
      type="button"
      className={`${styles.toggle} ${isOpen ? styles.toggleActive : ''} ${hasUnread && !isOpen ? styles.toggleUnread : ''}`}
      onClick={handleClick}
      title={isOpen ? `Close AI chat (${KBD_HINT})` : `Open AI chat (${KBD_HINT})`}
    >
      <svg className={styles.glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 19c5 0 9-2 11-6 0-3-2-5-5-5-2 0-3 1-3 3 0 1 1 2 2 2" />
        <path d="M16 13c1-.5 2-1.5 2-3" />
        <circle cx="11" cy="11" r=".7" fill="currentColor" />
      </svg>
      <span>AI Chat</span>
      <span className={styles.kbd}>{KBD_HINT}</span>
    </button>
  )
}
