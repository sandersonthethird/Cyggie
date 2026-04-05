/**
 * useNoteEditor — shared note editing hook
 *
 * Data flow:
 *   mount ──► NOTES_GET ──► load note ──► populate editor + title
 *   title/content change ──► debounce 800ms ──► NOTES_UPDATE ──► onNoteUpdated?()
 *   save ──► NOTE_UPDATED broadcast (main → all windows) ──► update note+savedRef in each window
 *   save ──► NOTES_SUGGEST_TAG (fire-and-forget, non-blocking)
 *   deleteNote() ──► NOTES_DELETE ──► onNoteDeleted?()
 *   unmount (empty note) ──► NOTES_DELETE (fire-and-forget)
 *
 * justLoadedRef guard: prevents TipTap's markdown normalization on load from
 *   triggering a spurious save. The first onUpdate after loadEditorContent
 *   silently syncs savedNoteRef to the normalized form instead of marking dirty.
 *
 * Consumers must wrap in a component with key={noteId} to reset all state
 * when the selected note changes:
 *
 *   <NoteEditorInner key={noteId} noteId={noteId} ... />
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import type { Editor } from '@tiptap/react'
import { useTiptapMarkdown } from './useTiptapMarkdown'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useDebounce } from './useDebounce'
import { api } from '../api'
import type { Note, TagSuggestion } from '../../shared/types/note'

type LoadState = 'loading' | 'loaded' | 'notFound' | 'error'
type SaveStatus = 'saved' | 'saving' | 'error'

interface UseNoteEditorOpts {
  onNoteUpdated?: (note: Note) => void
  onNoteDeleted?: (noteId: string) => void
}

interface UseNoteEditorResult {
  note: Note | null
  loadState: LoadState
  titleDraft: string
  setTitleDraft: (v: string) => void
  contentDraft: string
  editor: Editor | null
  saveStatus: SaveStatus
  isPinned: boolean
  setIsPinned: (v: boolean) => void
  tagSuggestion: TagSuggestion | null
  dismissSuggestion: () => void
  deleteNote: () => Promise<void>
}

export function useNoteEditor(noteId: string, opts?: UseNoteEditorOpts): UseNoteEditorResult {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [note, setNote] = useState<Note | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [isPinned, setIsPinned] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [tagSuggestion, setTagSuggestion] = useState<TagSuggestion | null>(null)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)

  const savedNoteRef = useRef<Note | null>(null)
  const justLoadedRef = useRef(false)
  const titleDraftRef = useRef('')
  const contentDraftRef = useRef('')
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])
  useEffect(() => { titleDraftRef.current = titleDraft }, [titleDraft])
  useEffect(() => { contentDraftRef.current = contentDraft }, [contentDraft])

  const { editor, loadContent: loadEditorContent } = useTiptapMarkdown(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: true }),
        Image,
      ],
      editable: loadState === 'loaded',  // hook's useEffect calls setEditable reactively
      onUpdate: ({ editor: ed }) => {
        const mkd = ed.getMarkdown?.()
        const normalized = mkd ?? ed.getText()
        if (justLoadedRef.current && savedNoteRef.current) {
          // First onUpdate after load: sync baseline to TipTap's normalized form
          // so the debounce guard sees no change and skips the save.
          savedNoteRef.current = { ...savedNoteRef.current, content: normalized }
          justLoadedRef.current = false
        }
        setContentDraft(normalized)
      },
    },
    [],  // no extra deps — recreation driven by loadEditorContent
  )

  // Load note on mount
  useEffect(() => {
    api.invoke<Note | null>(IPC_CHANNELS.NOTES_GET, noteId)
      .then((loaded) => {
        if (!loaded) {
          setLoadState('notFound')
          return
        }
        savedNoteRef.current = loaded
        setNote(loaded)
        setTitleDraft(loaded.title ?? '')
        setContentDraft(loaded.content)
        setIsPinned(loaded.isPinned)
        justLoadedRef.current = true
        loadEditorContent(loaded.content)  // set BEFORE setLoadState so they batch; onCreate parses ✓
        // Safety fallback: clear justLoadedRef if onUpdate never fires
        // (e.g. setContent('') on an already-empty editor is a no-op)
        setTimeout(() => { justLoadedRef.current = false }, 0)
        setLoadState('loaded')
      })
      .catch(() => setLoadState('error'))
  }, [noteId, loadEditorContent])

  // Debounced auto-save
  const debouncedTitle = useDebounce(titleDraft, 800)
  const debouncedContent = useDebounce(contentDraft, 800)

  useEffect(() => {
    const saved = savedNoteRef.current
    if (!saved) return
    if (loadState !== 'loaded') return

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
        setNote(updated)
        setSaveStatus('saved')
        optsRef.current?.onNoteUpdated?.(updated)
      }
    }).catch(() => setSaveStatus('error'))
  }, [debouncedTitle, debouncedContent, loadState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch AI tag suggestion after save (non-blocking)
  useEffect(() => {
    const saved = savedNoteRef.current
    if (!saved || suggestionDismissed) return
    if (saved.companyId || saved.contactId) return
    if (saved.content.trim().length < 20) return

    api.invoke<TagSuggestion | null>(IPC_CHANNELS.NOTES_SUGGEST_TAG, saved.id)
      .then((s) => { if (s) setTagSuggestion(s) })
      .catch(() => { /* silent */ })
  }, [debouncedContent, suggestionDismissed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-window sync: update note state + saved baseline when another window saves
  useEffect(() => {
    return api.on(IPC_CHANNELS.NOTE_UPDATED, (updated: Note) => {
      if (updated.id !== noteId) return
      // Refresh timestamp display; update savedRef so next debounce comparison
      // is against the latest persisted content. Do NOT reset editor content —
      // that would discard any in-progress edits in this window.
      setNote(updated)
      savedNoteRef.current = updated
    })
  }, [noteId])

  const dismissSuggestion = useCallback(() => {
    setTagSuggestion(null)
    setSuggestionDismissed(true)
  }, [])

  const deleteNote = useCallback(async () => {
    const saved = savedNoteRef.current
    if (!saved) return
    await api.invoke(IPC_CHANNELS.NOTES_DELETE, saved.id)
    optsRef.current?.onNoteDeleted?.(saved.id)
  }, [])

  // Empty-note cleanup on unmount
  useEffect(() => {
    return () => {
      const saved = savedNoteRef.current
      if (!saved) return
      const draftTitle = titleDraftRef.current
      const draftContent = contentDraftRef.current
      const hasDraft = draftTitle.trim().length > 0 || draftContent.trim().length > 0

      // Flush pending edits before unmount so rich-text changes persist
      if (hasDraft) {
        const titleChanged = draftTitle !== (saved.title ?? '')
        const contentChanged = draftContent !== saved.content
        if (titleChanged || contentChanged) {
          api.invoke<Note | null>(
            IPC_CHANNELS.NOTES_UPDATE,
            saved.id,
            { title: draftTitle || null, content: draftContent }
          )
            .then((updated) => { if (updated) optsRef.current?.onNoteUpdated?.(updated) })
            .catch(() => { /* silent on unmount */ })
        }
        return
      }

      const isEmpty = !saved.content?.trim() && !(saved.title ?? '').trim()
      if (isEmpty) {
        api.invoke(IPC_CHANNELS.NOTES_DELETE, saved.id).catch(() => {/* fire-and-forget */})
      }
    }
  }, [noteId])  // also runs when switching notes within the same component

  return {
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
  }
}
