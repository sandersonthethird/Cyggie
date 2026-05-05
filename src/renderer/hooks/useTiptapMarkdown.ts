/**
 * useTiptapMarkdown — load markdown content into a TipTap editor reliably.
 *
 * WHY HTML-VIA-MARKED INSTEAD OF setContent({ contentType: 'markdown' }):
 *   @tiptap/markdown's parser path (via `setContent(md, { contentType: 'markdown' })`)
 *   miscompiles nested mixed lists — a UL nested under an OL item ends up as a sibling
 *   of the OL with text-directly-in-listItem (invalid schema), and ProseMirror lifts
 *   the UL out of the OL on focus. Inline formatting (bold/italic/links) inside nested
 *   sub-bullets is also dropped because the nested-list lexer doesn't run inline parsing.
 *
 *   Fix: convert markdown to HTML with `md.parse()` first (which produces correctly
 *   nested HTML with full inline formatting), then load via TipTap's default HTML
 *   setContent path. TipTap's HTML parser handles nested lists correctly and wraps
 *   text in <p> as the listItem schema requires. The Markdown extension is still
 *   present on the editor for serialization back via getMarkdown().
 *
 * PATTERN (state machine):
 *
 *   [CREATED — empty]
 *        │
 *        │ loadContent(markdown) called
 *        ▼
 *   contentRef.current = markdown
 *        │
 *        ▼ (useEffect fires when `editor` ref becomes available)
 *   editor.commands.setContent(md.parse(markdown))   // HTML setContent path
 *        │
 *        ▼
 *   editor renders correctly nested rich text ✓
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '@tiptap/react'
import type { Editor, UseEditorOptions } from '@tiptap/react'
import type { DependencyList } from 'react'
import { Marked } from 'marked'

// IMPORTANT: use a fresh Marked instance, NOT the global `marked` import.
// @tiptap/markdown's Markdown extension calls `marked.use({ extensions: [...] })`
// at editor-create time, registering its broken OrderedList tokenizer on the
// global instance. Any subsequent global `md.parse()` call would then go
// through that broken tokenizer and produce empty <li></li> for nested sub-bullets.
const md = new Marked()

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
  // Pass emitUpdate=false: TipTap's setEditable defaults to firing a synthetic
  // `update` event that bypasses ProseMirror's docChanged check, which would
  // otherwise call onUpdate with the empty initial doc on first mount and
  // trigger an empty auto-save.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(options.editable ?? true, false)
  }, [editor, options.editable])

  // When the editor first mounts, set any content that was queued via loadContent
  // before the editor was ready. We pre-convert markdown → HTML with marked because
  // @tiptap/markdown's markdown parsing path corrupts nested mixed lists.
  useEffect(() => {
    if (!editor || !contentRef.current) return
    const html = md.parse(contentRef.current) as string
    editor.commands.setContent(html, { emitUpdate: false })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Set content directly on the existing editor if it's ready, avoiding a second
  // full ProseMirror init. Falls back to contentRef so useEffect([editor]) picks
  // it up when the editor mounts (handles the race where editor isn't ready yet).
  const loadContent = useCallback((markdown: string) => {
    contentRef.current = markdown
    setIsLoaded(true)
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      const html = md.parse(markdown) as string
      ed.commands.setContent(html, { emitUpdate: false })
    }
    // If editor not ready yet, useEffect([editor]) handles it on mount
  }, [])

  return { editor, loadContent, isLoaded }
}
