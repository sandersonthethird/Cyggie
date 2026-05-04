import { useEffect, useRef } from 'react'
import { Message } from './Message'
import { useChatStore } from '../../stores/chat.store'
import styles from './PanelThread.module.css'

interface PanelThreadProps {
  /** When true (full-screen route), render messages at the larger reading size. */
  large?: boolean
  /** Streaming partial assistant message — rendered separately so per-token
   *  updates don't fight Message memoization. Empty string when not streaming. */
  streamedContent: string
  isLoading: boolean
}

/**
 * Singleton message-list view. Mounted ONCE inside ChatPanelRoot and portaled
 * into the rail or full-screen route based on which slot is currently
 * registered as the mount point. This is what preserves scroll position and
 * the "stuck-to-bottom" pin across pop-out / minimize.
 *
 *   ┌──────────────────────────────────────┐
 *   │ User: question 1                      │  ←  Message (memoized)
 *   │ AI: answer 1                          │  ←  Message (memoized)
 *   │ ... more messages ...                 │
 *   │ AI: streaming partial...              │  ←  inline render, NOT memoized
 *   └──────────────────────────────────────┘
 */
export function PanelThread({ large = false, streamedContent, isLoading }: PanelThreadProps) {
  const panelSession = useChatStore((s) => s.panelSession)
  const messages = panelSession?.messages ?? []

  const scrollRef = useRef<HTMLDivElement>(null)
  const stuckToBottomRef = useRef(true)

  // Auto-scroll to bottom when new content arrives, but only if the user is
  // already pinned there. Lets users scroll up to read while AI is streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stuckToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, streamedContent])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stuckToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const showThinking = isLoading && !streamedContent

  if (messages.length === 0 && !isLoading) {
    return (
      <div className={styles.thread}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Ask Cyggie anything</p>
          <p className={styles.emptyHint}>
            Search across your meetings, companies, contacts, and notes — or start with the page you're on.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className={styles.thread} onScroll={handleScroll}>
      {messages.map((msg, i) => {
        if (msg.role === 'system') {
          return (
            <div key={i} className={styles.systemDivider}>
              <span>{msg.content}</span>
            </div>
          )
        }
        return (
          <Message
            key={i}
            role={msg.role}
            authorInitials={msg.role === 'user' ? 'You' : 'AI'}
            content={msg.content}
            plain={msg.role === 'user'}
            large={large}
          />
        )
      })}
      {streamedContent && (
        <Message
          key="streaming"
          role="assistant"
          authorInitials="AI"
          content={streamedContent}
          large={large}
        />
      )}
      {showThinking && (
        <div className={styles.thinking}>
          <span className={styles.thinkingDot} />
          <span className={styles.thinkingDot} />
          <span className={styles.thinkingDot} />
        </div>
      )}
    </div>
  )
}
