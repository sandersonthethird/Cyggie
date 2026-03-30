import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote } from '../../../shared/types/company'
import ConfirmDialog from '../common/ConfirmDialog'
import { useDebounce } from '../../hooks/useDebounce'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import styles from './NoteDetailModal.module.css'
import { api } from '../../api'

interface NoteDetailModalProps {
  noteId: string
  onClose: () => void
  onDeleted: (noteId: string) => void
  onUpdated: (note: CompanyNote) => void
}

type State =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error' }
  | { status: 'loaded'; note: CompanyNote }

export function NoteDetailModal({ noteId, onClose, onDeleted, onUpdated }: NoteDetailModalProps) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [isPinned, setIsPinned] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const savedNoteRef = useRef<CompanyNote | null>(null)

  const { editor, loadContent } = useTiptapMarkdown({
    extensions: [StarterKit, Markdown],
    onUpdate: ({ editor: e }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mkd = (e as any).getMarkdown?.()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setContentDraft(mkd ?? (e as any).getText?.() ?? '')
    }
  }, [noteId])

  useEffect(() => {
    window.api
      .invoke<CompanyNote | null>(IPC_CHANNELS.COMPANY_NOTES_GET, noteId)
      .then((note) => {
        if (!note) {
          setState({ status: 'notFound' })
        } else {
          savedNoteRef.current = note
          setTitleDraft(note.title ?? '')
          setContentDraft(note.content)  // baseline for spurious-save guard
          loadContent(note.content)       // populates the editor with parsed markdown
          setIsPinned(note.isPinned)
          setState({ status: 'loaded', note })
        }
      })
      .catch(() => setState({ status: 'error' }))
  }, [noteId, loadContent])

  // Debounced auto-save
  const debouncedTitle = useDebounce(titleDraft, 800)
  const debouncedContent = useDebounce(contentDraft, 800)

  useEffect(() => {
    const saved = savedNoteRef.current
    if (!saved) return
    const titleChanged = debouncedTitle !== (saved.title ?? '')
    const contentChanged = debouncedContent !== saved.content
    if (!titleChanged && !contentChanged) return

    window.api
      .invoke<CompanyNote | null>(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        noteId,
        { title: debouncedTitle || null, content: debouncedContent }
      )
      .then((updated) => {
        if (updated) {
          savedNoteRef.current = updated
          setSaveError(false)
          onUpdated(updated)
        }
      })
      .catch(() => setSaveError(true))
  }, [debouncedTitle, debouncedContent]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(async () => {
    const saved = savedNoteRef.current
    if (saved) {
      const titleChanged = titleDraft !== (saved.title ?? '')
      const contentChanged = contentDraft !== saved.content
      if (titleChanged || contentChanged) {
        try {
          const updated = await api.invoke<CompanyNote | null>(
            IPC_CHANNELS.COMPANY_NOTES_UPDATE,
            noteId,
            { title: titleDraft || null, content: contentDraft }
          )
          if (updated) {
            savedNoteRef.current = updated
            setSaveError(false)
            onUpdated(updated)
          }
        } catch {
          setSaveError(true)
        }
      }
    }
    onClose()
  }, [titleDraft, contentDraft, noteId, onClose, onUpdated])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    },
    [handleClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handlePinToggle = useCallback(async () => {
    const newPinned = !isPinned
    setIsPinned(newPinned)
    try {
      const updated = await api.invoke<CompanyNote | null>(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        noteId,
        { isPinned: newPinned }
      )
      if (updated) {
        savedNoteRef.current = updated
        onUpdated(updated)
      }
    } catch {
      // revert optimistic update
      setIsPinned(!newPinned)
    }
  }, [isPinned, noteId, onUpdated])

  const handleDeleteConfirm = useCallback(async () => {
    setConfirmDelete(false)
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_NOTES_DELETE, noteId)
      onDeleted(noteId)
      onClose()
    } catch {
      setDeleteError(true)
    }
  }, [noteId, onDeleted, onClose])

  return createPortal(
    <>
      <div className={styles.overlay} onClick={handleClose}>
        <div
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className={styles.header}>
            {state.status === 'loaded' ? (
              <input
                className={`${styles.titleInput} ${saveError ? styles.saveError : ''}`}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="Untitled"
              />
            ) : (
              <div className={styles.titlePlaceholder}>
                {state.status === 'loading' ? 'Loading…'
                  : state.status === 'notFound' ? 'Note not found'
                  : 'Error'}
              </div>
            )}
            <button className={styles.closeBtn} onClick={handleClose} title="Close">✕</button>
          </div>

          {/* Body */}
          {(state.status === 'notFound' || state.status === 'error') && (
            <div className={styles.stateMsg}>
              {state.status === 'notFound'
                ? 'This note could not be loaded.'
                : 'Failed to load note.'}
            </div>
          )}
          {state.status === 'loading' && (
            <div className={styles.stateMsg}>Loading…</div>
          )}
          {state.status === 'loaded' && (
            <div className={styles.bodyArea}>
              <div className={`${styles.editorContent} ${saveError ? styles.saveError : ''}`}>
                <EditorContent editor={editor} />
              </div>
            </div>
          )}

          {/* Footer */}
          {state.status === 'loaded' && (
            <div className={styles.footer}>
              <button
                className={`${styles.pinBtn} ${isPinned ? styles.pinned : ''}`}
                onClick={handlePinToggle}
                title={isPinned ? 'Unpin note' : 'Pin note'}
              >
                {isPinned ? '📌 Pinned' : '📋 Pin'}
              </button>
              <div className={styles.footerRight}>
                {deleteError && (
                  <span className={styles.deleteError}>Failed to delete note.</span>
                )}
                <button
                  className={styles.deleteBtn}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete note
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete note"
        message="This note will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDelete(false)}
      />
    </>,
    document.body
  )
}
