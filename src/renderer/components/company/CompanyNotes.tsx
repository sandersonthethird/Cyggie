import { useCallback, useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote } from '../../../shared/types/company'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import { NoteCreator } from '../common/NoteCreator'
import { NoteList } from '../common/NoteList'
import styles from './CompanyNotes.module.css'
import { api } from '../../api'
import { usePinToggle } from '../../hooks/usePinToggle'

interface CompanyNotesProps {
  companyId: string
  className?: string
  highlightNoteId?: string | null
  refreshKey?: number
  /** Bumped when a note changes in a sibling tab — triggers a silent re-pull. */
  noteSyncKey?: number
  /** Notify the parent that a note changed here, so sibling tabs can refresh. */
  onNoteChange?: () => void
}

export function CompanyNotes({ companyId, className, highlightNoteId, refreshKey, noteSyncKey, onNoteChange }: CompanyNotesProps) {
  const [notes, setNotes] = useState<CompanyNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const { togglePin, togglingIds } = usePinToggle<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_UPDATE, setNotes)

  const fetchNotes = useCallback(() => {
    return window.api
      .invoke<CompanyNote[]>(IPC_CHANNELS.COMPANY_NOTES_LIST, companyId)
      .then((data) => setNotes(Array.isArray(data) ? data : []))
      .catch(console.error)
  }, [companyId])

  // Reset loaded state when company changes or a new note is created externally
  useEffect(() => { setLoaded(false) }, [companyId, refreshKey])

  useEffect(() => {
    if (loaded) return
    fetchNotes().finally(() => setLoaded(true))
  }, [loaded, fetchNotes])

  // Silent cross-tab refresh: a note changed in a sibling tab. Re-pull without
  // toggling `loaded`, so the list doesn't flash "Loading…". Skip initial mount.
  useEffect(() => {
    if (!noteSyncKey) return
    void fetchNotes()
  }, [noteSyncKey, fetchNotes])

  async function createNote(content: string) {
    const note = await api.invoke<CompanyNote>(IPC_CHANNELS.COMPANY_NOTES_CREATE, {
      companyId,
      content: content.trim(),
    })
    setNotes((prev) => [note, ...prev])
    onNoteChange?.()
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
      onNoteChange?.()
    } catch (e) {
      console.error('[CompanyNotes] delete failed:', e)
    }
  }

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <NoteCreator onSave={createNote} />

      <NoteList
        notes={notes}
        loaded={loaded}
        highlightNoteId={highlightNoteId}
        onSelect={setSelectedNoteId}
        onTogglePin={togglePin}
        togglingIds={togglingIds}
        onDelete={deleteNote}
      />

      {selectedNoteId && (
        <NoteDetailModal
          noteId={selectedNoteId}
          onClose={() => { setSelectedNoteId(null); onNoteChange?.() }}
          onDeleted={handleNoteDeleted}
          onUpdated={handleNoteUpdated}
        />
      )}
    </div>
  )
}
