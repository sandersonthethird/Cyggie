import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactNote } from '../../../shared/types/contact'
import { ContactNoteDetailModal } from '../crm/ContactNoteDetailModal'
import { NoteCreator } from '../common/NoteCreator'
import { NoteList } from '../common/NoteList'
import styles from './ContactNotes.module.css'
import { api } from '../../api'
import { usePinToggle } from '../../hooks/usePinToggle'

interface ContactNotesProps {
  contactId: string
  className?: string
}

export function ContactNotes({ contactId, className }: ContactNotesProps) {
  const [notes, setNotes] = useState<ContactNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const { togglePin, togglingIds } = usePinToggle<ContactNote>(IPC_CHANNELS.CONTACT_NOTES_UPDATE, setNotes)

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<ContactNote[]>(IPC_CHANNELS.CONTACT_NOTES_LIST, contactId)
      .then((data) => setNotes(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [contactId, loaded])

  async function createNote(content: string) {
    const note = await api.invoke<ContactNote>(IPC_CHANNELS.CONTACT_NOTES_CREATE, {
      contactId,
      content: content.trim(),
    })
    setNotes((prev) => [note, ...prev])
  }

  async function deleteNote(noteId: string) {
    try {
      await api.invoke(IPC_CHANNELS.CONTACT_NOTES_DELETE, noteId)
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
      <NoteCreator onSave={createNote} draftKey={`contact:${contactId}`} />

      <NoteList
        notes={notes}
        loaded={loaded}
        onSelect={setSelectedNoteId}
        onTogglePin={togglePin}
        togglingIds={togglingIds}
        onDelete={deleteNote}
      />

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
