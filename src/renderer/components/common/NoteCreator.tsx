/**
 * NoteCreator — shared rich-text editor for creating new notes inline.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ State machine                                            │
 *   │   idle ─focus──▶ adding                                  │
 *   │     │             │                                      │
 *   │     │             ├─ Cmd+Enter / Save click ─▶ saving    │
 *   │     │             │      │                               │
 *   │     │             │      ├─ onSave() resolves ─▶ idle    │
 *   │     │             │      │  (clear + blur)               │
 *   │     │             │      └─ onSave() rejects  ─▶ adding  │
 *   │     │             │         (inline error, content kept) │
 *   │     │             │                                      │
 *   │     │             └─ Esc / Cancel click ────▶ idle       │
 *   │     │                (clear + blur)                      │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Used by CompanyNotes and ContactNotes detail tabs. Atomic save: parent
 * receives the markdown via onSave() and is responsible for the IPC call.
 *
 * Why TipTap (not textarea):
 *   - Live WYSIWYG of bold/italic/headings/lists/links as the user types
 *   - Markdown shortcuts (e.g. `# `, `- `, `**bold**`) work via StarterKit
 *   - Same extension set as NoteDetailModal so round-tripping is consistent
 *
 * Why use `editor.isEmpty` (not `markdown.trim()`):
 *   TipTap handles whitespace-only paragraphs and bare empty headings; trim()
 *   would still see newline characters and incorrectly let an empty note save.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { getJSON, setJSON, removeKey } from '../../lib/safe-storage'
import { EditorContent, type Editor } from '@tiptap/react'
import { TiptapBubbleMenu } from './TiptapBubbleMenu'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import { TABLE_EXTENSIONS } from '../../lib/tiptap-extensions'
import styles from './NoteCreator.module.css'

interface NoteCreatorProps {
  onSave: (markdown: string) => Promise<void>
  placeholder?: string
  /**
   * Stable per-entity key (e.g. `company:<id>`). When set, the in-progress
   * draft is persisted to localStorage on every edit and restored on mount, so
   * typed-but-unsaved text survives an app close / reload / accidental nav. The
   * draft is cleared on successful save and on cancel. Omit to disable.
   */
  draftKey?: string
}

/** Namespaced localStorage key for a composer draft. */
function draftStorageKey(draftKey: string): string {
  return `cyggie:note-draft:${draftKey}`
}

/** Read the editor's content as markdown (falls back to plain text). */
function getEditorMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor as any).getMarkdown?.() ?? editor.getText()
}

export function NoteCreator({ onSave, placeholder = 'Add a note…', draftKey }: NoteCreatorProps) {
  const [focused, setFocused] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const { editor, loadContent } = useTiptapMarkdown(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: true }),
        Image,
        ...TABLE_EXTENSIONS,
        Placeholder.configure({ placeholder }),
      ],
      editable: true,
      onFocus: () => setFocused(true),
      // Treat Shift+Enter the same as plain Enter (paragraph split) instead of
      // inserting a soft <br>. Reason: textarea muscle memory makes users hit
      // Shift+Enter to start a new line. Without this, soft breaks serialize as
      // a single \n inside one paragraph, and on re-parse marked collapses them
      // into a single paragraph — so the note "loses" all paragraph structure.
      // Matches behavior of Notion/Linear/most note-taking editors.
      editorProps: {
        handleKeyDown(_view, event) {
          if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            return editor?.commands.splitBlock() ?? false
          }
          return false
        },
      },
    },
    [],
  )

  // Subscribe to editor transactions to keep `isEmpty` in sync. @tiptap/react v3's
  // useEditor does NOT re-render on every transaction by default, so reading
  // `editor.isEmpty` directly in render returns a stale value while the user types
  // — leaving the Save button disabled forever.
  const [isEmpty, setIsEmpty] = useState(true)
  useEffect(() => {
    if (!editor) { setIsEmpty(true); return }
    const sync = () => setIsEmpty(editor.isEmpty)
    sync()
    editor.on('update', sync)
    editor.on('create', sync)
    return () => { editor.off('update', sync); editor.off('create', sync) }
  }, [editor])

  const clearDraft = useCallback(() => {
    if (draftKey) removeKey(draftStorageKey(draftKey))
  }, [draftKey])

  // Persist the in-progress draft on every edit. Synchronous (no debounce):
  // localStorage writes are microseconds and notes are short, and writing
  // inline means a later `removeKey` on save/cancel always wins — there's no
  // pending timer that could resurrect an emptied draft. When the editor goes
  // empty (manual select-all-delete, or clearContent on save/cancel) we REMOVE
  // the draft rather than store "", so an emptied composer never restores stale
  // text on the next mount.
  useEffect(() => {
    if (!editor || !draftKey) return
    const key = draftStorageKey(draftKey)
    const persist = () => {
      if (editor.isEmpty) removeKey(key)
      else setJSON(key, getEditorMarkdown(editor))
    }
    editor.on('update', persist)
    return () => { editor.off('update', persist) }
  }, [editor, draftKey])

  // Restore a saved draft on mount / when the entity (draftKey) changes. If the
  // new key has a stored draft, load it and reveal the Save/Cancel row; if it
  // doesn't, clear the editor so one entity's draft can't leak into another.
  useEffect(() => {
    if (!editor || !draftKey) return
    const saved = getJSON<string>(draftStorageKey(draftKey), '')
    if (saved && saved.trim()) {
      loadContent(saved)
      setIsEmpty(false)
      setFocused(true)
    } else {
      editor.commands.clearContent()
    }
  }, [editor, draftKey, loadContent])

  const handleCancel = useCallback(() => {
    if (!editor) return
    editor.commands.clearContent()
    clearDraft()
    setError(null)
    setFocused(false)
    ;(editor.view.dom as HTMLElement).blur()
  }, [editor, clearDraft])

  const handleSave = useCallback(async () => {
    if (!editor || creating || editor.isEmpty) return
    const md = getEditorMarkdown(editor)
    setCreating(true)
    setError(null)
    try {
      await onSave(md)
      editor.commands.clearContent()
      clearDraft()
      setFocused(false)
      ;(editor.view.dom as HTMLElement).blur()
    } catch (err) {
      console.error('[NoteCreator] save failed:', err, { contentLength: md.length })
      setError("Couldn't save note. Try again.")
    } finally {
      setCreating(false)
    }
  }, [editor, creating, onSave, clearDraft])

  // Cmd/Ctrl+Enter to save, Esc to cancel. Bound on the wrapper so we catch
  // before TipTap handles them as text input.
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }, [handleSave, handleCancel])

  // Track blur on the editor surface — collapses actions when user leaves
  // and the editor is empty (matches the original textarea UX).
  useEffect(() => {
    if (!editor) return
    const handleBlur = () => {
      // Defer so that clicking a button inside the actions row counts as
      // "still focused" and doesn't collapse before the click handler runs.
      setTimeout(() => {
        if (!containerRef.current) return
        if (containerRef.current.contains(document.activeElement)) return
        if (editor.isEmpty) setFocused(false)
      }, 0)
    }
    editor.on('blur', handleBlur)
    return () => { editor.off('blur', handleBlur) }
  }, [editor])

  // Use the reactive `isEmpty` state (not editor.isEmpty getter) — see the
  // useEffect above for why. The save guard inside handleSave can read the live
  // getter directly because it only runs on user action, not during render.
  const canSave = !!editor && !isEmpty && !creating

  return (
    <div ref={containerRef} className={styles.container} onKeyDown={handleKeyDown}>
      <div className={`${styles.editor} ${focused ? styles.editorFocused : ''}`}>
        <TiptapBubbleMenu editor={editor} />
        <EditorContent editor={editor} />
      </div>
      {focused && (
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={handleCancel} disabled={creating} type="button">
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            onClick={() => void handleSave()}
            disabled={!canSave}
            type="button"
          >
            Save Note
          </button>
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}
