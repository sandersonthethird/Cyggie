/**
 * NotePaneEditor — inline note editor for the three-pane Notes view.
 *
 * Wraps useNoteEditor with key={noteId} to reset all hook state (editor,
 * debounce, savedNoteRef) cleanly when the selected note changes.
 *
 *   noteId=null ──► empty state placeholder
 *   noteId=string ──► NotePaneEditorInner (key forces remount on switch)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useNoteEditor } from '../../hooks/useNoteEditor'
import { NoteTagger } from './NoteTagger'
import { TagSuggestionBanner } from './TagSuggestionBanner'
import { api } from '../../api'
import styles from './NotePaneEditor.module.css'
import type { Note, TagSuggestion } from '../../../shared/types/note'

interface Props {
  noteId: string | null
  onNoteUpdated: (note: Note) => void
  onNoteDeleted: (noteId: string) => void
}

export default function NotePaneEditor({ noteId, onNoteUpdated, onNoteDeleted }: Props) {
  if (!noteId) {
    return (
      <div className={styles.emptyState}>
        Select a note or press ⌘N to create one
      </div>
    )
  }
  return (
    <NotePaneEditorInner
      key={noteId}
      noteId={noteId}
      onNoteUpdated={onNoteUpdated}
      onNoteDeleted={onNoteDeleted}
    />
  )
}

interface InnerProps {
  noteId: string
  onNoteUpdated: (note: Note) => void
  onNoteDeleted: (noteId: string) => void
}

function NotePaneEditorInner({ noteId, onNoteUpdated, onNoteDeleted }: InnerProps) {
  const {
    note,
    loadState,
    titleDraft,
    setTitleDraft,
    editor,
    saveStatus,
    isPinned,
    setIsPinned,
    tagSuggestion,
    dismissSuggestion,
    deleteNote,
  } = useNoteEditor(noteId, { onNoteUpdated, onNoteDeleted })

  const savedNoteRef = useRef<Note | null>(null)
  useEffect(() => { if (note) savedNoteRef.current = note }, [note])

  const [localNote, setLocalNote] = useState<Note | null>(null)
  useEffect(() => { if (note) setLocalNote(note) }, [note])

  const handleTagCompany = useCallback(async (companyId: string | null) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { companyId })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated); onNoteUpdated(updated) }
    } catch {/* ignore */}
  }, [onNoteUpdated])

  const handleTagContact = useCallback(async (contactId: string | null) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { contactId })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated); onNoteUpdated(updated) }
    } catch {/* ignore */}
  }, [onNoteUpdated])

  const handleAcceptSuggestion = useCallback(async (suggestion: TagSuggestion) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, {
        companyId: suggestion.companyId,
        contactId: suggestion.contactId,
      })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated); onNoteUpdated(updated) }
    } catch {/* ignore */}
    dismissSuggestion()
  }, [dismissSuggestion, onNoteUpdated])

  const handlePinToggle = useCallback(async () => {
    const n = savedNoteRef.current
    if (!n) return
    const newPinned = !isPinned
    setIsPinned(newPinned)
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { isPinned: newPinned })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated); onNoteUpdated(updated) }
    } catch {
      setIsPinned(!newPinned)
    }
  }, [isPinned, setIsPinned, onNoteUpdated])

  const handleDelete = useCallback(async () => {
    await deleteNote()
  }, [deleteNote])

  return (
    <div className={styles.container}>
      {/* Title */}
      <input
        className={styles.titleInput}
        placeholder="Untitled"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus() }
        }}
        disabled={loadState === 'loading'}
      />

      {/* Tagger row */}
      {localNote && (
        <div className={styles.taggerRow}>
          <NoteTagger
            companyId={localNote.companyId}
            companyName={localNote.companyName}
            contactId={localNote.contactId}
            contactName={localNote.contactName}
            onTagCompany={handleTagCompany}
            onTagContact={handleTagContact}
          />
        </div>
      )}

      {/* Tag suggestion banner */}
      {tagSuggestion && !localNote?.companyId && !localNote?.contactId && (
        <TagSuggestionBanner
          suggestion={tagSuggestion}
          onAccept={handleAcceptSuggestion}
          onDismiss={dismissSuggestion}
        />
      )}

      {/* Editor */}
      {(loadState === 'loaded' || loadState === 'loading') && (
        <EditorContent editor={editor} className={styles.editor} />
      )}
      {loadState === 'notFound' && (
        <div className={styles.stateMsg}>Note not found.</div>
      )}
      {loadState === 'error' && (
        <div className={styles.stateMsg}>Failed to load note.</div>
      )}

      {/* Footer */}
      <div className={styles.footer}>
        <span className={`${styles.saveStatus} ${saveStatus === 'error' ? styles.saveStatusError : ''}`}>
          {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : ''}
        </span>
        <div className={styles.footerActions}>
          <button
            className={`${styles.pinBtn} ${isPinned ? styles.pinBtnActive : ''}`}
            onClick={handlePinToggle}
            title={isPinned ? 'Unpin note' : 'Pin note'}
          >
            {isPinned ? '📌' : '📍'}
          </button>
          <button className={styles.deleteBtn} onClick={handleDelete} title="Delete note">
            🗑
          </button>
        </div>
      </div>
    </div>
  )
}
