import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactNote } from '../../../shared/types/contact'
import { ContactNoteDetailModal } from '../crm/ContactNoteDetailModal'
import styles from './ContactNotes.module.css'

interface ContactNotesProps {
  contactId: string
  className?: string
}

export function ContactNotes({ contactId, className }: ContactNotesProps) {
  const [notes, setNotes] = useState<ContactNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<ContactNote[]>(IPC_CHANNELS.CONTACT_NOTES_LIST, contactId)
      .then((data) => setNotes(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [contactId, loaded])

  async function createNote() {
    if (!newContent.trim()) return
    setCreating(true)
    try {
      const note = await window.api.invoke<ContactNote>(IPC_CHANNELS.CONTACT_NOTES_CREATE, {
        contactId,
        content: newContent.trim()
      })
      setNotes((prev) => [note, ...prev])
      setNewContent('')
    } catch (e) {
      console.error('[ContactNotes] create failed:', e)
    } finally {
      setCreating(false)
    }
  }

  async function deleteNote(noteId: string) {
    try {
      await window.api.invoke(IPC_CHANNELS.CONTACT_NOTES_DELETE, noteId)
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    } catch (e) {
      console.error('[ContactNotes] delete failed:', e)
    }
  }

  function handleNoteUpdated(updated: ContactNote) {
    setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n))
  }

  function handleNoteDeleted(deletedId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== deletedId))
    setSelectedNoteId(null)
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
        <div
          key={note.id}
          className={styles.note}
          onClick={() => setSelectedNoteId(note.id)}
        >
          <div className={styles.noteContent}>{note.content}</div>
          <div className={styles.noteMeta}>
            <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <button
              className={styles.deleteBtn}
              onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {selectedNoteId && (
        <ContactNoteDetailModal
          noteId={selectedNoteId}
          onClose={() => setSelectedNoteId(null)}
          onUpdated={handleNoteUpdated}
          onDeleted={handleNoteDeleted}
        />
      )}
    </div>
  )
}
