/**
 * NoteDetail — full-page route for creating and editing standalone notes.
 *
 * Routes: /note/new, /note/:id
 *
 * State machine:
 *
 *   'new' ──► (first keystroke) ──► 'creating' ──► 'loaded'
 *                                        │
 *                                     error ──► 'error'
 *
 *   'loading' ──► 'loaded'
 *       │
 *    error ──► 'notFound'
 *
 *   'loaded':
 *     content change ──► debounce 800ms ──► save ──► saveStatus: 'saved'
 *     tag change ──► immediate save
 *     navigate away with empty note ──► NOTES_DELETE (fire-and-forget)
 *
 * See also: NoteDetailModal.tsx — keep debounce/flush logic in sync.
 */

import React, { useCallback, useEffect, useRef, useState, Component } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useDebounce } from '../hooks/useDebounce'
import { NoteTagger } from '../components/notes/NoteTagger'
import { TagSuggestionBanner } from '../components/notes/TagSuggestionBanner'
import { api } from '../api'
import styles from './NoteDetail.module.css'
import type { Note, TagSuggestion } from '../../shared/types/note'

type SaveStatus = 'saved' | 'saving' | 'error'
type RouteState =
  | { status: 'new' }
  | { status: 'loading' }
  | { status: 'creating' }
  | { status: 'loaded'; note: Note }
  | { status: 'notFound' }
  | { status: 'error' }

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

function NoteDetailInner() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isNew = id === 'new'

  const [routeState, setRouteState] = useState<RouteState>(isNew ? { status: 'new' } : { status: 'loading' })
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [isPinned, setIsPinned] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [tagSuggestion, setTagSuggestion] = useState<TagSuggestion | null>(null)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)

  // Folder picker state
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [availableFolders, setAvailableFolders] = useState<string[]>([])
  const [folderInput, setFolderInput] = useState('')
  const folderPickerRef = useRef<HTMLDivElement>(null)

  const savedNoteRef = useRef<Note | null>(null)
  // Track whether we've already initialized editor content for the loaded note
  const editorInitialized = useRef(false)
  // routeState ref for use inside editor callbacks (avoids stale closure)
  const routeStateRef = useRef(routeState)
  useEffect(() => { routeStateRef.current = routeState }, [routeState])

  // Create note on first keystroke (for /note/new) — called from editor onUpdate
  const handleFirstInput = useCallback(async (content: string, title: string) => {
    if (routeStateRef.current.status !== 'new') return
    setRouteState({ status: 'creating' })
    try {
      const note = await api.invoke<Note>(IPC_CHANNELS.NOTES_CREATE, { content, title: title || null })
      savedNoteRef.current = note
      setRouteState({ status: 'loaded', note })
      navigate(`/note/${note.id}`, { replace: true })
    } catch {
      setRouteState({ status: 'error' })
    }
  }, [navigate])

  // Tiptap editor
  const titleInputRef = useRef<HTMLInputElement>(null)
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,
      Link.configure({ openOnClick: true }),
      Image,
    ],
    content: '',  // initialized empty; synced when note loads
    onUpdate: ({ editor: ed }) => {
      const mkd = (ed.storage.markdown as { getMarkdown?: () => string } | undefined)?.getMarkdown?.()
      if (mkd === undefined) console.warn('[NoteDetail] Markdown ext not ready, falling back to getText()')
      const md = mkd ?? ed.getText()
      setContentDraft(md)
      if (routeStateRef.current.status === 'new' && md.trim()) {
        void handleFirstInput(md, titleDraft)
      }
    },
  })

  // Sync editor content when note loads (guard isFocused to avoid cursor jump)
  useEffect(() => {
    if (routeState.status === 'loaded' && editor && !editorInitialized.current) {
      editorInitialized.current = true
      editor.commands.setContent(routeState.note.content ?? '', false)
    }
  }, [routeState, editor])

  // Sync editor editable state
  useEffect(() => {
    if (!editor) return
    const editable = routeState.status !== 'creating' && routeState.status !== 'loading'
    editor.setEditable(editable)
  }, [editor, routeState.status])

  // Load existing note
  useEffect(() => {
    if (isNew) return
    editorInitialized.current = false
    api.invoke<Note | null>(IPC_CHANNELS.NOTES_GET, id)
      .then((note) => {
        if (!note) {
          setRouteState({ status: 'notFound' })
          return
        }
        savedNoteRef.current = note
        setTitleDraft(note.title ?? '')
        setContentDraft(note.content)
        setIsPinned(note.isPinned)
        setRouteState({ status: 'loaded', note })
      })
      .catch(() => setRouteState({ status: 'error' }))
  }, [id, isNew])

  // Debounced auto-save
  const debouncedTitle = useDebounce(titleDraft, 800)
  const debouncedContent = useDebounce(contentDraft, 800)

  useEffect(() => {
    const saved = savedNoteRef.current
    if (!saved) return
    if (routeState.status !== 'loaded') return

    const titleChanged = debouncedTitle !== (saved.title ?? '')
    const contentChanged = debouncedContent !== saved.content
    if (!titleChanged && !contentChanged) return
    if (!debouncedContent.trim() && !debouncedTitle.trim()) return  // never overwrite with blank

    setSaveStatus('saving')
    api.invoke<Note | null>(
      IPC_CHANNELS.NOTES_UPDATE,
      saved.id,
      { title: debouncedTitle || null, content: debouncedContent }
    ).then((updated) => {
      if (updated) {
        savedNoteRef.current = updated
        setSaveStatus('saved')
      }
    }).catch(() => setSaveStatus('error'))
  }, [debouncedTitle, debouncedContent, routeState.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch AI tag suggestion after note is saved (non-blocking)
  useEffect(() => {
    const note = savedNoteRef.current
    if (!note || suggestionDismissed) return
    if (note.companyId || note.contactId) return
    if (note.content.trim().length < 20) return

    api.invoke<TagSuggestion | null>(IPC_CHANNELS.NOTES_SUGGEST_TAG, note.id)
      .then((s) => { if (s) setTagSuggestion(s) })
      .catch(() => { /* silent — no banner on failure */ })
  }, [debouncedContent, suggestionDismissed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Flush unsaved changes on navigate-away
  const flushAndCleanup = useCallback(async () => {
    const saved = savedNoteRef.current
    if (!saved) return

    if (!contentDraft.trim() && !titleDraft.trim()) {
      api.invoke(IPC_CHANNELS.NOTES_DELETE, saved.id).catch(() => {/* fire-and-forget */})
      return
    }

    const titleChanged = titleDraft !== (saved.title ?? '')
    const contentChanged = contentDraft !== saved.content
    if (titleChanged || contentChanged) {
      await api.invoke<Note | null>(
        IPC_CHANNELS.NOTES_UPDATE,
        saved.id,
        { title: titleDraft || null, content: contentDraft }
      ).catch(() => {/* best-effort */})
    }
  }, [contentDraft, titleDraft])

  // Tag handlers
  const handleTagCompany = useCallback(async (companyId: string | null, _companyName: string | null) => {
    const note = savedNoteRef.current
    if (!note) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, { companyId })
      if (updated) {
        savedNoteRef.current = updated
        setRouteState({ status: 'loaded', note: updated })
        setTagSuggestion(null)
      }
    } catch {/* ignore */}
  }, [])

  const handleTagContact = useCallback(async (contactId: string | null, _contactName: string | null) => {
    const note = savedNoteRef.current
    if (!note) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, { contactId })
      if (updated) {
        savedNoteRef.current = updated
        setRouteState({ status: 'loaded', note: updated })
        setTagSuggestion(null)
      }
    } catch {/* ignore */}
  }, [])

  const handleAcceptSuggestion = useCallback(async (suggestion: TagSuggestion) => {
    const note = savedNoteRef.current
    if (!note) return
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, {
        companyId: suggestion.companyId,
        contactId: suggestion.contactId
      })
      if (updated) {
        savedNoteRef.current = updated
        setRouteState({ status: 'loaded', note: updated })
      }
    } catch {/* ignore */}
    setTagSuggestion(null)
    setSuggestionDismissed(true)
  }, [])

  // --- Folder picker handlers ---

  const openFolderPicker = useCallback(async () => {
    const folders = await api.invoke<string[]>(IPC_CHANNELS.NOTES_LIST_FOLDERS)
    setAvailableFolders(folders)
    setFolderInput('')
    setFolderPickerOpen(true)
  }, [])

  const handleSetFolder = useCallback(async (folderPath: string | null) => {
    const note = savedNoteRef.current
    if (!note) return
    setFolderPickerOpen(false)
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, { folderPath })
      if (updated) {
        savedNoteRef.current = updated
        setRouteState({ status: 'loaded', note: updated })
      }
    } catch (err) {
      console.error('Failed to set folder', err)
    }
  }, [])

  // Close folder picker on outside click
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
    const note = savedNoteRef.current
    if (!note) return
    const newPinned = !isPinned
    setIsPinned(newPinned)
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, { isPinned: newPinned })
      if (updated) savedNoteRef.current = updated
    } catch {
      setIsPinned(!newPinned)
    }
  }, [isPinned])

  const handleDelete = useCallback(async () => {
    const note = savedNoteRef.current
    if (!note) return
    await api.invoke(IPC_CHANNELS.NOTES_DELETE, note.id).catch(() => {/* ignore */})
    navigate('/notes', { replace: true })
  }, [navigate])

  const handleBack = useCallback(async () => {
    await flushAndCleanup()
    if (window.history.length > 1) {
      navigate(-1)
    } else {
      navigate('/notes')
    }
  }, [flushAndCleanup, navigate])

  const handleRetry = useCallback(() => {
    const saved = savedNoteRef.current
    if (!saved) return
    setSaveStatus('saving')
    api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, saved.id, {
      title: titleDraft || null,
      content: contentDraft
    }).then((updated) => {
      if (updated) {
        savedNoteRef.current = updated
        setSaveStatus('saved')
      }
    }).catch(() => setSaveStatus('error'))
  }, [titleDraft, contentDraft])

  const note = routeState.status === 'loaded' ? routeState.note : null

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={handleBack} title="Back to notes">
          ←
        </button>

        {note && (
          <div className={styles.folderPickerWrapper} ref={folderPickerRef}>
            <button
              className={styles.folderPickerTrigger}
              onClick={() => folderPickerOpen ? setFolderPickerOpen(false) : void openFolderPicker()}
              title={note.folderPath ?? 'No folder assigned'}
            >
              {note.folderPath ? note.folderPath.split('/').pop() : 'No folder'}
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
                      className={`${styles.folderPickerOption} ${f === note.folderPath ? styles.folderPickerOptionActive : ''}`}
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
        )}

        <input
          ref={titleInputRef}
          className={styles.titleInput}
          placeholder="Untitled"
          value={titleDraft}
          onChange={(e) => {
            setTitleDraft(e.target.value)
            if (routeState.status === 'new' && (e.target.value || contentDraft)) {
              void handleFirstInput(contentDraft, e.target.value)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              editor?.commands.focus()
            }
          }}
          disabled={routeState.status === 'creating' || routeState.status === 'loading'}
        />
        {note?.sourceMeetingId && (
          <button
            className={styles.meetingLink}
            onClick={async () => {
              await flushAndCleanup()
              navigate(`/meeting/${note.sourceMeetingId}`)
            }}
            title="View original meeting"
          >
            View meeting →
          </button>
        )}
        {note && (
          <>
            <button
              className={`${styles.pinBtn} ${isPinned ? styles.pinBtnActive : ''}`}
              onClick={handlePinToggle}
              title={isPinned ? 'Unpin note' : 'Pin note'}
            >
              {isPinned ? '📌 Pinned' : 'Pin'}
            </button>
            <button className={styles.deleteBtn} onClick={handleDelete}>
              Delete
            </button>
          </>
        )}
      </div>

      {(routeState.status === 'new' || routeState.status === 'loaded' || routeState.status === 'creating') && (
        <>
          {note && (
            <div className={styles.taggerRow}>
              <NoteTagger
                companyId={note.companyId}
                companyName={note.companyName}
                contactId={note.contactId}
                contactName={note.contactName}
                onTagCompany={handleTagCompany}
                onTagContact={handleTagContact}
              />
            </div>
          )}

          {tagSuggestion && !note?.companyId && !note?.contactId && (
            <div className={styles.suggestionRow}>
              <TagSuggestionBanner
                suggestion={tagSuggestion}
                onAccept={handleAcceptSuggestion}
                onDismiss={() => {
                  setTagSuggestion(null)
                  setSuggestionDismissed(true)
                }}
              />
            </div>
          )}

          <EditorContent editor={editor} className={styles.tiptapEditor} />
        </>
      )}

      {routeState.status === 'loading' && (
        <div className={styles.stateMsg}>Loading…</div>
      )}
      {routeState.status === 'notFound' && (
        <div className={styles.stateMsg}>Note not found.</div>
      )}
      {routeState.status === 'error' && (
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

export default function NoteDetail() {
  const navigate = useNavigate()
  return (
    <NoteErrorBoundary onBack={() => navigate('/notes')}>
      <NoteDetailInner />
    </NoteErrorBoundary>
  )
}
