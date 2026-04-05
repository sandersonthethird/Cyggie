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
import { useNavigate } from 'react-router-dom'
import { EditorContent } from '@tiptap/react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useNoteEditor } from '../../hooks/useNoteEditor'
import { useEditableTitle } from '../../hooks/useEditableTitle'
import { useFindInPage } from '../../hooks/useFindInPage'
import FindBar from '../common/FindBar'
import { NoteTagger } from './NoteTagger'
import { TagSuggestionBanner } from './TagSuggestionBanner'
import { TiptapBubbleMenu } from '../common/TiptapBubbleMenu'
import { api } from '../../api'
import styles from './NotePaneEditor.module.css'
import type { Note, TagSuggestion } from '../../../shared/types/note'
import type { Meeting } from '../../../shared/types/meeting'

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
  const navigate = useNavigate()
  const {
    note,
    loadState,
    titleDraft,
    setTitleDraft,
    contentDraft,
    editor,
    saveStatus,
    isPinned,
    setIsPinned,
    tagSuggestion,
    dismissSuggestion,
    deleteNote,
  } = useNoteEditor(noteId, { onNoteUpdated, onNoteDeleted })

  const [findOpen, setFindOpen] = useState(false)
  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    goToNext,
    goToPrev,
    highlightedContent,
  } = useFindInPage({
    text: contentDraft,
    isOpen: findOpen,
    onOpen: () => setFindOpen(true),
    onClose: () => setFindOpen(false),
  })

  const {
    editingTitle,
    titleRef,
    handleTitleClick,
    handleTitleBlur,
    handleTitleKeyDown,
  } = useEditableTitle(titleDraft, setTitleDraft)

  const savedNoteRef = useRef<Note | null>(null)
  useEffect(() => { if (note) savedNoteRef.current = note }, [note])

  const [localNote, setLocalNote] = useState<Note | null>(null)
  useEffect(() => { if (note) setLocalNote(note) }, [note])

  const [sourceMeetingTitle, setSourceMeetingTitle] = useState<string | null>(null)
  useEffect(() => {
    if (!localNote?.sourceMeetingId) return
    api.invoke<Meeting>(IPC_CHANNELS.MEETING_GET, localNote.sourceMeetingId)
      .then((meeting) => setSourceMeetingTitle(meeting.title))
      .catch(() => setSourceMeetingTitle(null))
  }, [localNote?.sourceMeetingId])

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

  // Folder picker state
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [folderInput, setFolderInput] = useState('')
  const folderPickerRef = useRef<HTMLDivElement>(null)

  const openFolderPicker = useCallback(async () => {
    const folders = await api.invoke<string[]>(IPC_CHANNELS.NOTES_LIST_FOLDERS)
    setAvailableFolders(folders)
    setFolderInput('')
    setFolderPickerOpen(true)
  }, [])

  const handleSetFolder = useCallback(async (folderPath: string | null) => {
    const n = savedNoteRef.current
    if (!n) return
    setFolderPickerOpen(false)
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { folderPath })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated); onNoteUpdated(updated) }
    } catch (err) {
      console.error('Failed to set folder', err)
    }
  }, [onNoteUpdated])

  useEffect(() => {
    if (!folderPickerOpen) return
    const handler = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setFolderPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [folderPickerOpen])

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
      {/* Header: title + meta row */}
      <div className={styles.header}>
        {editingTitle ? (
          <input
            ref={titleRef}
            className={styles.titleInput}
            placeholder="Untitled"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={(e) => handleTitleKeyDown(e, () => editor?.commands.focus())}
            disabled={loadState === 'loading'}
          />
        ) : (
          <h2
            className={styles.title}
            onClick={handleTitleClick}
            title="Click to rename"
          >
            {titleDraft || <span className={styles.titlePlaceholder}>Untitled</span>}
          </h2>
        )}

        {localNote && (
          <div className={styles.meta}>
            <div className={styles.timestamps}>
              {localNote.createdAt && (
                <span className={styles.timestamp}>
                  Created {new Date(localNote.createdAt).toLocaleString(undefined, {
                    month: 'numeric', day: 'numeric', year: 'numeric',
                    hour: 'numeric', minute: '2-digit'
                  })}
                </span>
              )}
              {localNote.updatedAt && (
                <span className={styles.timestamp}>
                  Edited {new Date(localNote.updatedAt).toLocaleString(undefined, {
                    month: 'numeric', day: 'numeric', year: 'numeric',
                    hour: 'numeric', minute: '2-digit'
                  })}
                </span>
              )}
            </div>

            <button
              className={styles.popoutBtn}
              title="Open in new window"
              onClick={() => void api.invoke(IPC_CHANNELS.APP_OPEN_NOTE_WINDOW, localNote.id)}
            >
              ⤢
            </button>

            <div className={styles.folderPickerWrapper} ref={folderPickerRef}>
              <button
                className={styles.folderPickerTrigger}
                onClick={() => folderPickerOpen ? setFolderPickerOpen(false) : void openFolderPicker()}
                title={localNote.folderPath ?? 'No folder assigned'}
              >
                {localNote.folderPath ? localNote.folderPath.split('/').pop() : 'No folder'}
              </button>
              {folderPickerOpen && (() => {
                const filteredFolders = availableFolders.filter(f =>
                  f.toLowerCase().includes(folderInput.toLowerCase())
                )
                const exactMatch = filteredFolders.some(
                  f => f.toLowerCase() === folderInput.trim().toLowerCase()
                )
                return (
                  <div className={styles.folderPickerDropdown}>
                    <input
                      autoFocus
                      className={styles.folderPickerInput}
                      placeholder="Folder name…"
                      value={folderInput}
                      onChange={e => setFolderInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const trimmed = folderInput.trim()
                          if (trimmed) void handleSetFolder(trimmed)
                          else if (filteredFolders.length > 0) void handleSetFolder(filteredFolders[0])
                        }
                        if (e.key === 'Escape') setFolderPickerOpen(false)
                      }}
                    />
                    <button className={styles.folderPickerOption} onClick={() => void handleSetFolder(null)}>
                      None
                    </button>
                    {filteredFolders.map(f => (
                      <button
                        key={f}
                        className={`${styles.folderPickerOption} ${f === localNote.folderPath ? styles.folderPickerOptionActive : ''}`}
                        onClick={() => void handleSetFolder(f)}
                      >
                        {f}
                      </button>
                    ))}
                    {folderInput.trim() && !exactMatch && (
                      <button
                        className={`${styles.folderPickerOption} ${styles.folderPickerOptionNew}`}
                        onClick={() => void handleSetFolder(folderInput.trim())}
                      >
                        Create "{folderInput.trim()}"
                      </button>
                    )}
                  </div>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {findOpen && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          matchCount={matchCount}
          activeMatchIndex={activeMatchIndex}
          onNext={goToNext}
          onPrev={goToPrev}
          onClose={() => setFindOpen(false)}
        />
      )}

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

      {/* Source meeting link */}
      {localNote?.sourceMeetingId && sourceMeetingTitle && (
        <div className={styles.meetingChipRow}>
          <button
            className={styles.meetingChip}
            onClick={() => navigate(`/meeting/${localNote.sourceMeetingId}`)}
            title="View source meeting"
          >
            📋 {sourceMeetingTitle} →
          </button>
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
        <div className={styles.editor}>
          {findOpen && findQuery ? (
            <div className={styles.findPreview}>{highlightedContent}</div>
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      )}
      {!findOpen && <TiptapBubbleMenu editor={editor} />}

      {loadState === 'notFound' && (
        <div className={styles.stateMsg}>Note not found.</div>
      )}
      {loadState === 'error' && (
        <div className={styles.stateMsg}>Failed to load note.</div>
      )}

      {/* Footer: save status + pin + delete */}
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
