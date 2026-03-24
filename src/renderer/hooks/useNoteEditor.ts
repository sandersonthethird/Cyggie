/**
 * useNoteEditor — shared note editing hook
 *
 * Data flow:
 *   mount ──► NOTES_GET ──► load note ──► populate editor + title
 *   title/content change ──► debounce 800ms ──► NOTES_UPDATE ──► onNoteUpdated?()
 *   save ──► NOTES_SUGGEST_TAG (fire-and-forget, non-blocking)
 *   deleteNote() ──► NOTES_DELETE ──► onNoteDeleted?()
 *   unmount (empty note) ──► NOTES_DELETE (fire-and-forget)
 *
 * Consumers must wrap in a component with key={noteId} to reset all state
 * when the selected note changes:
 *
 *   <NoteEditorInner key={noteId} noteId={noteId} ... />
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import type { Editor } from '@tiptap/react'
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
  const editorInitialized = useRef(false)
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

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
        setLoadState('loaded')
      })
      .catch(() => setLoadState('error'))
  }, [noteId])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,
      Link.configure({ openOnClick: true }),
      Image,
    ],
    content: '',
    editable: false,  // enabled once note loads
    onUpdate: ({ editor: ed }) => {
      const mkd = (ed.storage.markdown as { getMarkdown?: () => string } | undefined)?.getMarkdown?.()
      const md = mkd ?? ed.getText()
      setContentDraft(md)
    },
  })

  // Initialize editor once note loads
  useEffect(() => {
    if (loadState === 'loaded' && editor && !editorInitialized.current && savedNoteRef.current) {
      editorInitialized.current = true
      editor.commands.setContent(savedNoteRef.current.content ?? '', false)
      editor.setEditable(true)
    }
  }, [loadState, editor])

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
      const isEmpty = !savedNoteRef.current?.content?.trim() && !savedNoteRef.current?.title?.trim()
      if (isEmpty) {
        api.invoke(IPC_CHANNELS.NOTES_DELETE, saved.id).catch(() => {/* fire-and-forget */})
      }
    }
  }, [])  // empty deps: runs only on unmount

  return {
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
  }
}
