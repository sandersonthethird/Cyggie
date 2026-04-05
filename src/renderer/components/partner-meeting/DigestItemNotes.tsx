/**
 * DigestItemNotes — lazy-mount TipTap editor for digest item fields.
 *
 * Collapsed state:
 *   Shows ReactMarkdown preview (or placeholder if empty).
 *   Click → mounts TipTap, transfers content, focuses.
 *
 * Expanded state:
 *   Live TipTap editor. onBlur → flush save → collapse.
 *   Debounce 800ms auto-saves while typing (only when hasEdited=true).
 *
 * State machine:
 *   collapsed ──► click ──► isLoadingRef=true ──► loadContent(content)
 *                                │                       │
 *                                │              TipTap onUpdate: setDraft(md)
 *                                │              markEdited() BLOCKED (isLoadingRef)
 *                                │                       │
 *                                │              setTimeout → isLoadingRef=false
 *                                │
 *                       user types ──► markEdited() → hasEdited=true
 *                                │         └─► debounce 800ms ──► onSave(content)
 *                                │
 *                       blur/collapse ──► flushSave ──► collapsed
 *                                         (saves only if hasEdited=true)
 *
 * Used in: CompanyDigestItem (brief + meeting notes), AdminDigestItem (meeting notes).
 * Keeps at most 1-2 live TipTap instances active across the page (each item collapses on blur).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import ReactMarkdown from 'react-markdown'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import { useDigestItemAutoSave } from '../../hooks/useDigestItemAutoSave'
import styles from './DigestItemNotes.module.css'

interface DigestItemNotesProps {
  content: string | null
  placeholder?: string
  disabled?: boolean
  onSave: (content: string) => void
}

export function DigestItemNotes({ content, placeholder = 'Click to add notes…', disabled = false, onSave }: DigestItemNotesProps) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-save state machine: dirty tracking prevents wiping DB briefs set externally
  const { draft, setDraft, markEdited, flushSave } = useDigestItemAutoSave({
    content,
    onSave,
    expanded,
  })

  // Guards markEdited() from firing during programmatic loadContent calls
  const isLoadingRef = useRef(false)
  // Guards onUpdate from firing during TipTap editor initialization (before user expands)
  const expandedRef = useRef(false)
  expandedRef.current = expanded

  const { editor, loadContent } = useTiptapMarkdown({
    extensions: [
      StarterKit,
      Markdown,
      Link.configure({ openOnClick: false }),
    ],
    editable: !disabled,
    onUpdate: ({ editor: e }) => {
      if (!expandedRef.current) return  // TipTap fires onUpdate on init — ignore until user expands
      const md = e.getMarkdown?.() ?? e.getText()
      setDraft(md)
      if (!isLoadingRef.current) markEdited()  // blocked during programmatic loads
    },
  })

  // Load content prop into editor when user expands (use prop directly, not stale draft)
  useEffect(() => {
    if (expanded) {
      isLoadingRef.current = true
      loadContent(content ?? '')
      const tid = setTimeout(() => { isLoadingRef.current = false }, 0)
      return () => clearTimeout(tid)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])  // intentionally omit content: only load on expand transition

  // Focus on mount
  useEffect(() => {
    if (expanded && editor) {
      editor.commands.focus('end')
    }
  }, [expanded, editor])

  const collapse = useCallback(() => {
    if (editor) {
      const md = editor.getMarkdown?.() ?? editor.getText()
      flushSave(md)  // only saves if user has edited since last expand
    }
    setExpanded(false)
  }, [editor, flushSave])

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
