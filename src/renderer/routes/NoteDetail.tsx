/**
 * NoteDetail — full-page route for creating and editing standalone notes.
 *
 * Routes:
 *   /note/new → NoteDetailNew  (exported default + named)
 *   /note/:id → NoteDetailLoaded  (named export)
 *
 * State machine — NoteDetailNew:
 *
 *   'new' ──► (first keystroke) ──► 'creating' ──► navigate('/note/:id')
 *                                        │
 *                                     error ──► 'error'
 *
 * State machine — NoteDetailLoaded (via useNoteEditor):
 *
 *   'loading' ──► 'loaded'
 *       │
 *    error ──► 'notFound'
 *
 *   'loaded':
 *     content change ──► debounce 800ms ──► save ──► saveStatus: 'saved'
 *     tag change ──► immediate save
 *     navigate away with empty note ──► NOTES_DELETE (fire-and-forget)
 */

import React, { useCallback, useEffect, useRef, useState, Component } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useNoteEditor } from '../hooks/useNoteEditor'
import { useNoteShareMenu } from '../hooks/useNoteShareMenu'
import { TABLE_EXTENSIONS } from '../lib/tiptap-extensions'
import { useEditableTitle } from '../hooks/useEditableTitle'
import { NoteTagger } from '../components/notes/NoteTagger'
import { TagSuggestionBanner } from '../components/notes/TagSuggestionBanner'
import { TiptapBubbleMenu } from '../components/common/TiptapBubbleMenu'
import { api } from '../api'
import styles from './NoteDetail.module.css'
import type { Note, TagSuggestion } from '../../shared/types/note'
import type { Meeting } from '../../shared/types/meeting'

type SaveStatus = 'saved' | 'saving' | 'error'

class NoteErrorBoundary extends Component<
  { children: React.ReactNode; onBack: () => void },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[NoteDetail] Uncaught error:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorBoundary}>
          <p>Something went wrong loading this note.</p>
          <button onClick={this.props.onBack}>← Back to notes</button>
          <button onClick={() => this.setState({ hasError: false })}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// NoteDetailNew — handles /note/new
// Creates a note on first keystroke, then navigates to /note/:id
// ---------------------------------------------------------------------------

function NoteDetailNewInner() {
  const navigate = useNavigate()

  type NewState = 'new' | 'creating' | 'error'
  const [state, setState] = useState<NewState>('new')
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const handleFirstInput = useCallback(async (content: string, title: string) => {
    if (stateRef.current !== 'new') return
    setState('creating')
    try {
      const note = await api.invoke<Note>(IPC_CHANNELS.NOTES_CREATE, { content, title: title || null })
      navigate(`/note/${note.id}`, { replace: true })
    } catch {
      setState('error')
    }
  }, [navigate])

  const titleInputRef = useRef<HTMLInputElement>(null)
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,
      Link.configure({ openOnClick: true }),
      Image,
      ...TABLE_EXTENSIONS,
    ],
    content: '',
    onUpdate: ({ editor: ed }) => {
      const md = ed.getMarkdown?.() ?? ed.getText()
      setContentDraft(md)
      if (stateRef.current === 'new' && md.trim()) {
        void handleFirstInput(md, titleDraft)
      }
    },
  })

  useEffect(() => {
    if (!editor) return
    editor.setEditable(state !== 'creating')
  }, [editor, state])

  const handleBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/notes')
  }, [navigate])

  return (
    <div className={styles.container}>
      <div className={styles.stickyHeader}>
        <button className={styles.back} onClick={handleBack}>← Back</button>
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <input
              ref={titleInputRef}
              className={styles.titleInput}
              placeholder="Untitled"
              value={titleDraft}
              onChange={(e) => {
                setTitleDraft(e.target.value)
                if (state === 'new' && (e.target.value || contentDraft)) {
                  void handleFirstInput(contentDraft, e.target.value)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); editor?.commands.focus() }
              }}
              disabled={state === 'creating'}
            />
          </div>
          <div className={styles.meta}>
            <span className={styles.metaDate}>New note</span>
          </div>
        </div>
      </div>

      {state !== 'error' && (
        <div className={styles.tiptapEditor}>
          <EditorContent editor={editor} />
        </div>
      )}
      <TiptapBubbleMenu editor={editor ?? null} />
      {state === 'error' && (
        <div className={styles.stateMsg}>Failed to create note.</div>
      )}
    </div>
  )
}

export default function NoteDetailNew() {
  const navigate = useNavigate()
  return (
    <NoteErrorBoundary onBack={() => navigate('/notes')}>
      <NoteDetailNewInner />
    </NoteErrorBoundary>
  )
}

// ---------------------------------------------------------------------------
// NoteDetailLoaded — handles /note/:id via useNoteEditor
// ---------------------------------------------------------------------------

function NoteDetailLoadedInner() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isPopOut = new URLSearchParams(window.location.search).get('popout') === 'true'

  const {
    note,
    loadState,
    titleDraft,
    setTitleDraft,
    editor,
    contentDraft,
    saveStatus,
    isPinned,
    setIsPinned,
    tagSuggestion,
    dismissSuggestion,
    deleteNote,
  } = useNoteEditor(id!)

  const {
    editingTitle,
    titleRef,
    handleTitleClick,
    handleTitleBlur,
    handleTitleKeyDown,
  } = useEditableTitle(titleDraft, setTitleDraft)

  // Source meeting title fetch
  const [sourceMeetingTitle, setSourceMeetingTitle] = useState<string | null>(null)

  const savedNoteRef = useRef<Note | null>(null)
  useEffect(() => { if (note) savedNoteRef.current = note }, [note])

  const [localNote, setLocalNote] = useState<Note | null>(null)
  useEffect(() => { if (note) setLocalNote(note) }, [note])

  const {
    shareMenuOpen,
    setShareMenuOpen,
    shareMenuRef,
    canShare,
    handleCopyText,
    handleWebShare,
  } = useNoteShareMenu(localNote?.id ?? null, contentDraft)

  // Fetch source meeting title once when localNote has a sourceMeetingId
  useEffect(() => {
    if (!localNote?.sourceMeetingId) return
    api.invoke<Meeting>(IPC_CHANNELS.MEETING_GET, localNote.sourceMeetingId)
      .then((meeting) => setSourceMeetingTitle(meeting.title))
      .catch(() => setSourceMeetingTitle(null))  // suppress chip on failure
  }, [localNote?.sourceMeetingId])

  // Set window title in pop-out mode for Dock/taskbar identification
  useEffect(() => {
    if (!isPopOut) return
    if (loadState === 'loaded' && note) {
      document.title = note.title || 'Untitled note'
    }
  }, [isPopOut, loadState, note])

  // Auto-focus: editor body if note has a title, title input if blank
  useEffect(() => {
    if (loadState !== 'loaded' || !editor) return
    if (titleDraft) {
      editor.commands.focus('end')
    }
    // If titleDraft is empty, leave focus on nothing — user will click title
  }, [loadState]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTagCompany = useCallback(async (companyId: string | null) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { companyId })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated) }
    } catch {/* ignore */}
  }, [])

  const handleTagContact = useCallback(async (contactId: string | null) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, { contactId })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated) }
    } catch {/* ignore */}
  }, [])

  const handleAcceptSuggestion = useCallback(async (suggestion: TagSuggestion) => {
    const n = savedNoteRef.current
    if (!n) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, {
        companyId: suggestion.companyId,
        contactId: suggestion.contactId,
      })
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated) }
    } catch {/* ignore */}
    dismissSuggestion()
  }, [dismissSuggestion])

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
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated) }
    } catch (err) {
      console.error('Failed to set folder', err)
    }
  }, [])

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
      if (updated) { savedNoteRef.current = updated; setLocalNote(updated) }
    } catch {
      setIsPinned(!newPinned)
    }
  }, [isPinned, setIsPinned])

  const handleDelete = useCallback(async () => {
    await deleteNote()
    navigate('/notes', { replace: true })
  }, [deleteNote, navigate])

  const handleRetry = useCallback(() => {
    const n = savedNoteRef.current
    if (!n) return
    api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, n.id, {
      title: titleDraft || null,
      content: editor?.getMarkdown?.() ?? editor?.getText() ?? '',
    }).catch(() => {/* ignore */})
  }, [titleDraft, editor])

  const handleBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/notes')
  }, [navigate])

  return (
    <div className={styles.container}>
      <div className={styles.stickyHeader}>
        <button className={styles.back} onClick={handleBack}>← Back</button>

        <div className={styles.header}>
          <div className={styles.titleRow}>
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
              <div className={styles.titleActions}>
                <button
                  className={styles.popoutBtn}
                  title="Open in new window"
                  onClick={() => void api.invoke(IPC_CHANNELS.APP_OPEN_NOTE_WINDOW, localNote.id)}
                >
                  ⤢
                </button>
                <button
                  className={`${styles.pinBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                  onClick={handlePinToggle}
                  title={isPinned ? 'Unpin note' : 'Pin note'}
                >
                  {isPinned ? '📌 Pinned' : 'Pin'}
                </button>
                <div ref={shareMenuRef} className={styles.shareWrapper}>
                  <button
                    className={styles.shareBtn}
                    onClick={() => setShareMenuOpen(v => !v)}
                  >
                    Share ▾
                  </button>
                  {shareMenuOpen && (
                    <div className={styles.shareMenu}>
                      <button className={styles.shareMenuItem} onClick={handleCopyText}>
                        Copy text
                      </button>
                      <button
                        className={styles.shareMenuItem}
                        onClick={handleWebShare}
                        disabled={!canShare}
                      >
                        Share to web
                      </button>
                    </div>
                  )}
                </div>
                <button className={styles.deleteBtn} onClick={handleDelete}>
                  Delete
                </button>
              </div>
            )}
          </div>

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

              {localNote.sourceMeetingId && sourceMeetingTitle && (
                <button
                  className={styles.meetingChip}
                  onClick={() => navigate(`/meeting/${localNote.sourceMeetingId}`)}
                  title="View source meeting"
                >
                  📋 {sourceMeetingTitle} →
                </button>
              )}
            </div>
          )}
        </div>

        {(loadState === 'loaded' || loadState === 'loading') && localNote && (
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

        {tagSuggestion && !localNote?.companyId && !localNote?.contactId && (
          <div className={styles.suggestionRow}>
            <TagSuggestionBanner
              suggestion={tagSuggestion}
              onAccept={handleAcceptSuggestion}
              onDismiss={dismissSuggestion}
            />
          </div>
        )}
      </div>

      {(loadState === 'loaded' || loadState === 'loading') && (
        <>
          <div className={styles.tiptapEditor}>
            <EditorContent editor={editor} />
          </div>
          <TiptapBubbleMenu editor={editor} />
        </>
      )}

      {loadState === 'loading' && (
        <div className={styles.stateMsg}>Loading…</div>
      )}
      {loadState === 'notFound' && (
        <div className={styles.stateMsg}>Note not found.</div>
      )}
      {loadState === 'error' && (
        <div className={styles.stateMsg}>Failed to load note.</div>
      )}

      {saveStatus === 'error' && (
        <div className={styles.footer}>
          <button className={`${styles.saveStatus} ${styles.saveStatusError}`} onClick={handleRetry}>
            Unsaved — click to retry
          </button>
        </div>
      )}
    </div>
  )
}

export function NoteDetailLoaded() {
  const navigate = useNavigate()
  return (
    <NoteErrorBoundary onBack={() => navigate('/notes')}>
      <NoteDetailLoadedInner />
    </NoteErrorBoundary>
  )
}
