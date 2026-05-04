import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './Message.module.css'

const MARKDOWN_PLUGINS = [remarkGfm]

export type MessageRole = 'user' | 'assistant'

interface MessageProps {
  role: MessageRole
  authorInitials: string
  /** "9:42 AM", "Today · 9:42 AM", or empty. */
  time?: string
  content: string
  /** Render content as plain pre-wrapped text (user) instead of markdown (AI). */
  plain?: boolean
  /** Render larger text — used by AIChatFullscreen. */
  large?: boolean
  /** Optional trailing element (e.g., streaming caret indicator). */
  trailing?: ReactNode
}

/**
 * Granola-style asymmetric message row.
 *
 *   role=ai    → flat-left, no bubble, crimson-gradient avatar at left
 *   role=user  → bubbled-right, slate avatar at right
 *
 * Memoized by (role, content, time, plain, large). Streaming chunks update
 * `content` per token so the partial-message row should NOT use this component
 * directly — render it inline so it doesn't fight memoization.
 */
function MessageInner({ role, authorInitials, time, content, plain = false, large = false, trailing }: MessageProps) {
  const isUser = role === 'user'
  return (
    <div className={`${styles.row} ${isUser ? styles.rowUser : styles.rowAi} ${large ? styles.rowLarge : ''}`}>
      <div className={`${styles.avatar} ${isUser ? styles.avatarUser : styles.avatarAi}`}>
        {authorInitials}
      </div>
      <div className={styles.body}>
        {time && <div className={styles.meta}>{time}</div>}
        <div className={styles.content}>
          {plain ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
          ) : (
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{content}</ReactMarkdown>
          )}
          {trailing}
        </div>
      </div>
    </div>
  )
}

export const Message = memo(MessageInner)
