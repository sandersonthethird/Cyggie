/**
 * useTiptapMarkdown — wraps useEditor with the correct @tiptap/markdown pattern.
 *
 * WHY THIS EXISTS:
 *   @tiptap/markdown's parser must be invoked explicitly with { contentType: 'markdown' }.
 *   Calling setContent(markdown) without it treats the string as HTML — formatting lost.
 *
 * PATTERN (state machine):
 *
 *   [CREATED — empty]
 *        │
 *        │ loadContent(markdown) called
 *        ▼
 *   contentRef.current = markdown
 *   setLoadKey(k+1) ──► editor recreates
 *        │
 *        ▼
 *   new editor mounts (content: null)
 *        │
 *        ▼ (useEffect fires when `editor` ref changes)
 *   editor.commands.setContent(markdown, { contentType: 'markdown' })
 *        │ (triggers @tiptap/markdown's setContent override)
 *        ▼
 *   markdown.parse(content) → JSON → editor renders rich text ✓
 *
 * WHY useEffect([editor]) INSTEAD OF onCreate:
 *   @tiptap/markdown's setContent override calls this.editor.markdown.parse(), which
 *   requires this.editor.markdown to be initialized. That happens in onBeforeCreate.
 *   Using useEffect([editor]) guarantees we run AFTER full initialization — when
 *   this.editor.markdown is set and the setContent command override is registered.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import type { Editor, UseEditorOptions } from '@tiptap/react'
import type { DependencyList } from 'react'

interface UseTiptapMarkdownResult {
  editor: Editor | null
  loadContent: (markdown: string) => void
  isLoaded: boolean
}

export function useTiptapMarkdown(
  options: Omit<UseEditorOptions, 'content'>,
  deps: DependencyList = [],
): UseTiptapMarkdownResult {
  const contentRef = useRef('')
  const [isLoaded, setIsLoaded] = useState(false)

  // Keep a ref to options so onCreate closure always sees the latest value
  // without needing to be in the dep array (avoids infinite recreation).
  const optionsRef = useRef(options)
  useEffect(() => { optionsRef.current = options })

  const editor = useEditor(
    {
      ...options,
      content: null,  // always null — content is set via useEffect below so the markdown parser runs
      onCreate: ({ editor: e }) => {
        optionsRef.current.onCreate?.({ editor: e })
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps],
  )

  // Track editor instance in a ref so loadContent can set content directly
  // without triggering a second editor recreation.
  const editorRef = useRef<Editor | null>(null)
  useEffect(() => { editorRef.current = editor }, [editor])

  // Reactively toggle editable when options.editable changes —
  // avoids recreating the editor just to change read/write mode.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(options.editable ?? true)
  }, [editor, options.editable])

  // When the editor first mounts, set any content that was queued via loadContent
  // before the editor was ready. { contentType: 'markdown' } triggers @tiptap/markdown's
  // setContent override which calls this.editor.markdown.parse().
  // Running in useEffect guarantees this.editor.markdown is already initialized.
  useEffect(() => {
    if (!editor || !contentRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(editor.commands as any).setContent(contentRef.current, { contentType: 'markdown' })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Set content directly on the existing editor if it's ready, avoiding a second
  // full ProseMirror init. Falls back to contentRef so useEffect([editor]) picks
  // it up when the editor mounts (handles the race where editor isn't ready yet).
  const loadContent = useCallback((markdown: string) => {
    contentRef.current = markdown
    setIsLoaded(true)
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ed.commands as any).setContent(markdown, { contentType: 'markdown' })
    }
    // If editor not ready yet, useEffect([editor]) handles it on mount
  }, [])

  return { editor, loadContent, isLoaded }
}
