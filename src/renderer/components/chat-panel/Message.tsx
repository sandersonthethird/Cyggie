import { memo, type ReactNode } from 'react'
import { SafeMarkdown } from '../SafeMarkdown'
import { type FindMatch } from '../../hooks/useFindInPage'
import { CitationChipRow } from './CitationChip'
import type { Citation } from '../../../shared/types/chat'
import styles from './Message.module.css'

export type MessageRole = 'user' | 'assistant'

export interface FindHighlight {
  /** Match offsets relative to this message's `content`. */
  matches: FindMatch[]
  /** Index into `matches` of the active match within this message,
   *  or -1 when the global active match is in some other message. */
  activeIndex: number
}

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
  /** Per-message find slice — when provided, content renders with <mark>
   *  wrapping every match. Pass undefined for messages with no matches so
   *  the memoized component doesn't re-render unnecessarily. */
  findHighlight?: FindHighlight
  /** M5 — sources the assistant answer drew on; rendered as chips below content. */
  citations?: Citation[] | null
}

/**
 * Build React nodes for plain-text content with matches wrapped in <mark>.
 * Used for user messages (whitespace: pre-wrap) where injectFindMarks +
 * dangerouslySetInnerHTML would lose pre-wrap behavior.
 */
function plainWithMarks(content: string, hl: FindHighlight): ReactNode {
  if (hl.matches.length === 0) return content
  const parts: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < hl.matches.length; i++) {
    const { start, end } = hl.matches[i]
    if (start > cursor) parts.push(content.slice(cursor, start))
    parts.push(
      <mark key={i} className={i === hl.activeIndex ? 'markActive' : undefined}>
        {content.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < content.length) parts.push(content.slice(cursor))
  return parts
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
function MessageInner({ role, authorInitials, time, content, plain = false, large = false, trailing, findHighlight, citations }: MessageProps) {
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
            <span style={{ whiteSpace: 'pre-wrap' }}>
              {findHighlight ? plainWithMarks(content, findHighlight) : content}
            </span>
          ) : (
            <SafeMarkdown findHighlight={findHighlight}>{content}</SafeMarkdown>
          )}
          {!isUser && <CitationChipRow citations={citations} />}
          {trailing}
        </div>
      </div>
    </div>
  )
}

export const Message = memo(MessageInner)
