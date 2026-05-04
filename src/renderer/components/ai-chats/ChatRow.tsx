import { useEffect, useRef, useState } from 'react'
import { Pin, MessageSquare, MoreHorizontal } from 'lucide-react'
import type { ChatSessionRow } from '../../hooks/useChatActions'
import { relativeTime, absoluteTime } from '../../utils/relative-time'
import styles from './ChatRow.module.css'

interface ChatRowProps {
  row: ChatSessionRow
  selected?: boolean
  onClick: () => void
  onPin: () => void
  onUnpin: () => void
  onArchive: () => void
  onDelete: () => void
  onRename: (title: string) => Promise<void>
  /** Optional: open this chat in the dedicated /ai-chats/:id route. */
  onOpenFullScreen?: () => void
}

export default function ChatRow({
  row,
  selected,
  onClick,
  onPin,
  onUnpin,
  onArchive,
  onDelete,
  onRename,
  onOpenFullScreen,
}: ChatRowProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(row.title ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const title = row.title ?? row.previewText ?? '(Untitled chat)'
  const preview = row.previewText ?? ''
  const badgeClass = `${styles.badge} ${styles[`badge_${row.contextKind}`]}`

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={() => {
        if (!renaming && !menuOpen) onClick()
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !renaming) onClick()
      }}
    >
      <div className={styles.titleCol}>
        <div className={styles.titleRow}>
          {row.isPinned ? (
            <Pin size={11} className={styles.pinIcon} aria-label="Pinned" />
          ) : null}
          {renaming ? (
            <input
              className={styles.renameInput}
              autoFocus
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (renameValue.trim()) {
                    void onRename(renameValue.trim()).finally(() => setRenaming(false))
                  }
                } else if (e.key === 'Escape') {
                  setRenaming(false)
                  setRenameValue(row.title ?? '')
                }
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <span className={styles.title} title={title}>
              {title}
            </span>
          )}
        </div>
        {preview && <div className={styles.preview}>{preview}</div>}
        <div className={styles.metaRow}>
          {row.contextLabel && (
            <span className={badgeClass} title={row.contextLabel}>
              <span className={styles.badgeAvatar}>
                {(row.contextLabel[0] ?? '·').toUpperCase()}
              </span>
              {row.contextLabel}
            </span>
          )}
          <span className={styles.metaItem}>
            <MessageSquare size={11} />
            {row.messageCount}
          </span>
        </div>
      </div>
      <div className={styles.rightCol}>
        <span className={styles.timeAgo} title={absoluteTime(row.lastMessageAt)}>
          {relativeTime(row.lastMessageAt)}
        </span>
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            className={styles.menuBtn}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            title="More actions"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className={styles.menu} role="menu">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  setRenameValue(row.title ?? '')
                  setRenaming(true)
                }}
              >
                Rename
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  if (row.isPinned) onUnpin()
                  else onPin()
                }}
              >
                {row.isPinned ? 'Unpin' : 'Pin'}
              </button>
              {onOpenFullScreen && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    onOpenFullScreen()
                  }}
                >
                  Open full screen
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  onArchive()
                }}
              >
                Archive
              </button>
              <button
                className={styles.menuDanger}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                  if (window.confirm('Delete this chat? This cannot be undone.')) {
                    onDelete()
                  }
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
