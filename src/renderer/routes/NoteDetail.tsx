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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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

export default function NoteDetail() {
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

  const savedNoteRef = useRef<Note | null>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)

  // Load existing note
  useEffect(() => {
    if (isNew) return
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

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [])

  useEffect(() => {
    if (routeState.status === 'loaded') resizeTextarea()
  }, [routeState.status, resizeTextarea])

  // Create note on first keystroke (for /note/new)
  const handleFirstInput = useCallback(async (content: string, title: string) => {
    if (routeState.status !== 'new') return
    setRouteState({ status: 'creating' })
    try {
      const note = await api.invoke<Note>(IPC_CHANNELS.NOTES_CREATE, { content, title: title || null })
      savedNoteRef.current = note
      setRouteState({ status: 'loaded', note })
      // Redirect to the permanent URL without adding to history
      navigate(`/note/${note.id}`, { replace: true })
    } catch {
      setRouteState({ status: 'error' })
    }
  }, [routeState.status, navigate])

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

    // Delete empty notes (no content, no title)
    if (!contentDraft.trim() && !titleDraft.trim()) {
      api.invoke(IPC_CHANNELS.NOTES_DELETE, saved.id).catch(() => {/* fire-and-forget */})
      return
    }

    // Flush any in-flight debounced changes
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

  // Tag a note immediately (no debounce — explicit user action)
  const handleTagCompany = useCallback(async (companyId: string | null, companyName: string | null) => {
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
    void companyName // used only in NoteTagger display
  }, [])

  const handleTagContact = useCallback(async (contactId: string | null, contactName: string | null) => {
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
    void contactName
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

  const handlePinToggle = useCallback(async () => {
    const note = savedNoteRef.current
    if (!note) return
    const newPinned = !isPinned
    setIsPinned(newPinned)
    try {
      const updated = await api.invoke<Note | null>(IPC_CHANNELS.NOTES_UPDATE, note.id, { isPinned: newPinned })
      if (updated) savedNoteRef.current = updated
    } catch {
      setIsPinned(!newPinned) // revert
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
        <input
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
              contentRef.current?.focus()
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

          <textarea
            ref={contentRef}
            className={styles.contentArea}
            placeholder="Write a note…"
            value={contentDraft}
            rows={1}
            onChange={(e) => {
              setContentDraft(e.target.value)
              resizeTextarea()
              if (routeState.status === 'new' && e.target.value) {
                void handleFirstInput(e.target.value, titleDraft)
              }
            }}
            disabled={routeState.status === 'creating'}
          />
        </>
      )}

      {(routeState.status === 'loading' || routeState.status === 'creating') && (
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
