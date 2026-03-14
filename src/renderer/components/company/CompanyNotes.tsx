import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote } from '../../../shared/types/company'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import styles from './CompanyNotes.module.css'

interface CompanyNotesProps {
  companyId: string
  className?: string
}

export function CompanyNotes({ companyId, className }: CompanyNotesProps) {
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      const note = await window.api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
        companyId,
        content: newContent.trim()
      })
      setNotes((prev) => [note, ...prev])
      setNewContent('')
    } catch (e) {
      console.error('[CompanyNotes] create failed:', e)
    } finally {
      setCreating(false)
    }
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
      await window.api.invoke(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
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
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) createNote()
          }}
        />
        <button
          className={styles.saveBtn}
          onClick={createNote}
          disabled={!newContent.trim() || creating}
        >
          Save Note
        </button>
      </div>

      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && notes.length === 0 && (
        <div className={styles.empty}>No notes yet.</div>
      )}

      {notes.map((note) => (
        <div key={note.id} className={styles.note} onClick={() => setSelectedNoteId(note.id)}>
          <div className={styles.noteContent}>{note.content}</div>
          <div className={styles.noteMeta}>
            <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <button
              className={styles.deleteBtn}
              onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
            >Delete</button>
          </div>
        </div>
      ))}

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
