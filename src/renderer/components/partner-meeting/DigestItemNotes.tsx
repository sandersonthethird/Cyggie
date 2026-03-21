/**
 * DigestItemNotes — lazy-mount TipTap editor for digest item fields.
 *
 * Collapsed state:
 *   Shows ReactMarkdown preview (or placeholder if empty).
 *   Click → mounts TipTap, transfers content, focuses.
 *
 * Expanded state:
 *   Live TipTap editor. onBlur → flush save → collapse.
 *   Debounce 800ms auto-saves while typing.
 *
 * State machine:
 *   collapsed ──► click ──► expanded (TipTap mounted)
 *                                │
 *                           blur/collapse ──► flush save ──► collapsed
 *                                │
 *                        debounce 800ms ──► onSave(content)
 *
 * Used in: CompanyDigestItem (brief + meeting notes), AdminDigestItem (meeting notes).
 * Keeps at most 1-2 live TipTap instances active across the page (each item collapses on blur).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import ReactMarkdown from 'react-markdown'
import { useDebounce } from '../../hooks/useDebounce'
import styles from './DigestItemNotes.module.css'

interface DigestItemNotesProps {
  content: string | null
  placeholder?: string
  disabled?: boolean
  onSave: (content: string) => void
}

export function DigestItemNotes({ content, placeholder = 'Click to add notes…', disabled = false, onSave }: DigestItemNotesProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(content ?? '')
  const containerRef = useRef<HTMLDivElement>(null)
  const debouncedDraft = useDebounce(draft, 800)
  const draftRef = useRef(draft)
  draftRef.current = draft  // always current — avoids stale closure in onCreate

  // Sync content changes from parent (e.g., carry-over load) into local draft
  useEffect(() => {
    if (!expanded) {
      setDraft(content ?? '')
    }
  }, [content, expanded])

  // Auto-save when debounced draft changes (only while expanded)
  const latestOnSave = useRef(onSave)
  latestOnSave.current = onSave

  useEffect(() => {
    if (expanded) {
      latestOnSave.current(debouncedDraft)
    }
  }, [debouncedDraft, expanded])

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Markdown,
        Link.configure({ openOnClick: false }),
      ],
      content: null,           // set via onCreate so @tiptap/markdown parses properly
      editable: !disabled,
      onCreate: ({ editor: e }) => {
        if (draftRef.current) {
          e.commands.setContent(draftRef.current)
        }
      },
      onUpdate: ({ editor: e }) => {
        const md = e.storage.markdown?.getMarkdown?.() ?? e.getText()
        setDraft(md)
      },
    },
    [expanded] // re-initialize when toggled
  )

  // Focus on mount
  useEffect(() => {
    if (expanded && editor) {
      editor.commands.focus('end')
    }
  }, [expanded, editor])

  const collapse = useCallback(() => {
    if (editor) {
      const md = editor.storage.markdown?.getMarkdown?.() ?? editor.getText()
      setDraft(md)
      latestOnSave.current(md)
    }
    setExpanded(false)
  }, [editor])

  // Collapse when clicking outside the container
  useEffect(() => {
    if (!expanded) return
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        collapse()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [expanded, collapse])

  if (disabled) {
    return (
      <div className={styles.collapsed}>
        {draft ? (
          <ReactMarkdown className={styles.preview}>{draft}</ReactMarkdown>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
      </div>
    )
  }

  if (!expanded) {
    return (
      <div
        className={styles.collapsed}
        onClick={() => setExpanded(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(true) }}
      >
        {draft ? (
          <ReactMarkdown className={styles.preview}>{draft}</ReactMarkdown>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
      </div>
    )
  }

  return (
    <div ref={containerRef} className={styles.editor}>
      <EditorContent editor={editor} />
    </div>
  )
}
