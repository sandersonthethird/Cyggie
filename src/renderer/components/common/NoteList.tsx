/**
 * NoteList — shared note-card list for entity Notes tabs (Company, Contact).
 *
 * Renders pinned/unpinned cards with title, body preview, date, pin toggle,
 * and delete button. The shape is generic over note type via the NoteListItem
 * structural interface — entity-specific concerns (which IPC channel to call,
 * which detail modal to open) stay in the parent via callbacks.
 */

import type { ReactNode } from 'react'
import { SafeMarkdown } from '../SafeMarkdown'
import { stripMarkdownPreview } from '../../utils/format'
import styles from './NoteList.module.css'

export interface NoteListItem {
  id: string
  title?: string | null
  content: string
  isPinned: boolean
  createdAt: string | Date
}

interface NoteListProps<T extends NoteListItem> {
  notes: T[]
  loaded: boolean
  highlightNoteId?: string | null
  onSelect: (noteId: string) => void
  onTogglePin: (note: T) => Promise<void> | void
  togglingIds: Set<string>
  onDelete: (noteId: string) => Promise<void> | void
  emptyMessage?: ReactNode
}

export function NoteList<T extends NoteListItem>({
  notes,
  loaded,
  highlightNoteId,
  onSelect,
  onTogglePin,
  togglingIds,
  onDelete,
  emptyMessage = 'No notes yet.',
}: NoteListProps<T>) {
  if (!loaded) return <div className={styles.loading}>Loading…</div>
  if (notes.length === 0) return <div className={styles.empty}>{emptyMessage}</div>

  return (
    <>
      {notes.map((note) => {
        const content = note.content || ''
        const nl = content.indexOf('\n')
        const firstLine = nl >= 0 ? content.slice(0, nl) : content
        const explicitTitle = note.title?.trim()
        const title = explicitTitle || stripMarkdownPreview(firstLine)
        const body = explicitTitle
          ? (nl >= 0 && firstLine.trim() === explicitTitle
            ? content.slice(nl + 1).trim()
            : content.trim())
          : (nl >= 0 ? content.slice(nl + 1).trim() : '')
        const created = typeof note.createdAt === 'string' || note.createdAt instanceof Date
          ? new Date(note.createdAt)
          : new Date()
        return (
          <div
            key={note.id}
            className={`${styles.note} ${note.isPinned ? styles.notePinned : ''} ${note.id === highlightNoteId ? styles.noteHighlight : ''}`}
            onClick={() => onSelect(note.id)}
          >
            <div className={styles.noteTitleRow}>
              <div className={styles.noteTitle}>{title}</div>
              {note.isPinned && <span className={styles.pinnedBadge}>📌 Pinned</span>}
            </div>
            {body && (
              <div className={styles.noteBody}>
                <SafeMarkdown>{body.slice(0, 400)}</SafeMarkdown>
              </div>
            )}
            <div className={styles.noteMeta}>
              <span>{created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <div className={styles.noteMetaActions}>
                <button
                  className={`${styles.pinBtn} ${note.isPinned ? styles.pinned : ''}`}
                  disabled={togglingIds.has(note.id)}
                  onClick={(e) => { e.stopPropagation(); void onTogglePin(note) }}
                  title={note.isPinned ? 'Unpin' : 'Pin to top'}
                  type="button"
                >📌</button>
                <button
                  className={styles.deleteBtn}
                  onClick={(e) => { e.stopPropagation(); void onDelete(note.id) }}
                  type="button"
                >Delete</button>
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
