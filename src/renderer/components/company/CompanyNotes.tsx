import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote } from '../../../shared/types/company'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import styles from './CompanyNotes.module.css'
import { api } from '../../api'
import { usePinToggle } from '../../hooks/usePinToggle'
import { stripMarkdownPreview } from '../../utils/format'

interface CompanyNotesProps {
  companyId: string
  className?: string
  highlightNoteId?: string | null
  refreshKey?: number
}

export function CompanyNotes({ companyId, className, highlightNoteId, refreshKey }: CompanyNotesProps) {
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { togglePin, togglingIds } = usePinToggle<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_UPDATE, setNotes)

  // Reset loaded state when a new note is created externally (e.g. from Enhance modal)
  useEffect(() => { setLoaded(false) }, [refreshKey])

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      .then((data) => setNotes(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  async function createNote() {
    if (!newContent.trim()) return
    setCreating(true)
    try {
      const note = await api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        content: newContent.trim()
      })
      setNotes((prev) => [note, ...prev])
      setNewContent('')
      setFocused(false)
    } catch (e) {
      console.error('[CompanyNotes] create failed:', e)
    } finally {
      setCreating(false)
    }
  }

  function cancelNote() {
    setNewContent('')
    setFocused(false)
    textareaRef.current?.blur()
  }

  function handleNoteUpdated(updated: CompanyNote) {
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)))
  }

  function handleNoteDeleted(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId))
    setSelectedNoteId(null)
  }

  async function deleteNote(noteId: string) {
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    } catch (e) {
      console.error('[CompanyNotes] delete failed:', e)
    }
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>

      <div className={styles.newNote}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Add a note…"
          rows={focused ? 5 : 1}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) createNote()
            if (e.key === 'Escape') cancelNote()
          }}
        />
        {focused && (
          <div className={styles.noteActions}>
            <button className={styles.cancelBtn} onClick={cancelNote} disabled={creating}>
              Cancel
            </button>
            <button
              className={styles.saveBtn}
              onClick={createNote}
              disabled={!newContent.trim() || creating}
            >
              Save Note
            </button>
          </div>
        )}
      </div>

      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && notes.length === 0 && (
        <div className={styles.empty}>No notes yet.</div>
      )}

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
        return (
          <div key={note.id} className={`${styles.note} ${note.isPinned ? styles.notePinned : ''} ${note.id === highlightNoteId ? styles.noteHighlight : ''}`} onClick={() => setSelectedNoteId(note.id)}>
            <div className={styles.noteTitleRow}>
              <div className={styles.noteTitle}>{title}</div>
              {note.isPinned && <span className={styles.pinnedBadge}>📌 Pinned</span>}
            </div>
            {body && <div className={styles.noteBody}><ReactMarkdown>{body.slice(0, 400)}</ReactMarkdown></div>}
            <div className={styles.noteMeta}>
              <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <div className={styles.noteMetaActions}>
                <button
                  className={`${styles.pinBtn} ${note.isPinned ? styles.pinned : ''}`}
                  disabled={togglingIds.has(note.id)}
                  onClick={(e) => { e.stopPropagation(); void togglePin(note) }}
                  title={note.isPinned ? 'Unpin' : 'Pin to top'}
                >📌</button>
                <button
                  className={styles.deleteBtn}
                  onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
                >Delete</button>
              </div>
            </div>
          </div>
        )
      })}

      {selectedNoteId && (
        <NoteDetailModal
          noteId={selectedNoteId}
          onClose={() => setSelectedNoteId(null)}
          onDeleted={handleNoteDeleted}
          onUpdated={handleNoteUpdated}
        />
      )}
    </div>
  )
}
