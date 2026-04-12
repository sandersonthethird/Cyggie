/**
 * MemoEditModal — rich text editor modal for investment memos.
 *
 * Data flow:
 *   mount ──► loadContent(memo.latestVersion.contentMarkdown)
 *   user types ──► onUpdate → setContentDraft → useDebounce(800ms)
 *               ──► INVESTMENT_MEMO_SAVE_VERSION ──► onSaved(version)
 *               ──► savedContentRef.current = contentDraft (prevents re-save)
 *   close ──► flush: if contentDraft !== savedContentRef → final save ──► onClose()
 *
 * Spurious-save guard:
 *   savedContentRef is initialized to memo.latestVersion.contentMarkdown before
 *   loadContent is called. Tiptap normalizes markdown on first onUpdate — the
 *   debounced save only fires if debouncedContent !== savedContentRef.current.
 *   After each successful save, savedContentRef.current = contentDraft.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Link from '@tiptap/extension-link'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { InvestmentMemoVersion, InvestmentMemoWithLatest } from '../../../shared/types/company'
import { TiptapBubbleMenu } from '../common/TiptapBubbleMenu'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import { TABLE_EXTENSIONS } from '../../lib/tiptap-extensions'
import { useDebounce } from '../../hooks/useDebounce'
import { useFindInPage } from '../../hooks/useFindInPage'
import FindBar from '../common/FindBar'
import { api } from '../../api'
import styles from './MemoEditModal.module.css'

interface MemoEditModalProps {
  memo: InvestmentMemoWithLatest
  onSaved: (version: InvestmentMemoVersion) => void
  onClose: () => void
  initialFindQuery?: string
}

export function MemoEditModal({ memo, onSaved, onClose, initialFindQuery }: MemoEditModalProps) {
  if (!memo.latestVersion) return null

  return (
    <MemoEditModalInner
      key={memo.id}
      memo={memo}
      onSaved={onSaved}
      onClose={onClose}
      initialFindQuery={initialFindQuery}
    />
  )
}

function MemoEditModalInner({ memo, onSaved, onClose, initialFindQuery }: MemoEditModalProps) {
  const initialContent = memo.latestVersion?.contentMarkdown ?? ''
  const savedContentRef = useRef(initialContent)

  const [contentDraft, setContentDraft] = useState(initialContent)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [findOpen, setFindOpen] = useState(!!initialFindQuery)
  // findOpenRef stays true during the same keydown event so the Escape handler
  // doesn't close the modal while find is still open.
  const findOpenRef = useRef(!!initialFindQuery)
  useEffect(() => { findOpenRef.current = findOpen }, [findOpen])

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    goToNext,
    goToPrev,
  } = useFindInPage({
    text: contentDraft,
    isOpen: findOpen,
    onOpen: () => setFindOpen(true),
    onClose: () => setFindOpen(false),
  })

  // Pre-populate query when opened from view mode with an active search
  // useRef avoids ESLint exhaustive-deps warning — intentional initial-value-only pattern
  const initialFindQueryRef = useRef(initialFindQuery)
  useEffect(() => {
    if (initialFindQueryRef.current) setFindQuery(initialFindQueryRef.current)
  }, [setFindQuery]) // setFindQuery is a stable useState setter — effectively runs once

  const { editor, loadContent } = useTiptapMarkdown({
    extensions: [StarterKit, Markdown, Link, ...TABLE_EXTENSIONS],
    onUpdate: ({ editor: e }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mkd = (e as any).getMarkdown?.() ?? ''
      setContentDraft(mkd)
    },
  }, [memo.id])

  // Load content on mount
  useEffect(() => {
    loadContent(initialContent)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced auto-save
  const debouncedContent = useDebounce(contentDraft, 800)

  useEffect(() => {
    if (debouncedContent === savedContentRef.current) return
    doSave(debouncedContent)
  }, [debouncedContent]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doSave(content: string) {
    setSaveStatus('saving')
    try {
      const version = await api.invoke<InvestmentMemoVersion>(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        { contentMarkdown: content, changeNote: null }
      )
      savedContentRef.current = content
      setSaveStatus('saved')
      onSaved(version)
      // Clear "Saved" indicator after 2s
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
      saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
    }
  }

  const handleClose = useCallback(async () => {
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
    if (contentDraft !== savedContentRef.current) {
      try {
        const version = await api.invoke<InvestmentMemoVersion>(
          IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
          memo.id,
          { contentMarkdown: contentDraft, changeNote: null }
        )
        savedContentRef.current = contentDraft
        onSaved(version)
      } catch {
        // Best-effort flush — close anyway
      }
    }
    onClose()
  }, [contentDraft, memo.id, onSaved, onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If find bar is open, let FindBar's own Escape handler close it first.
        // findOpenRef.current is still true on this event even though setFindOpen(false)
        // was called by FindBar — state update hasn't flushed yet.
        if (findOpenRef.current) return
        void handleClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  return createPortal(
    <div className={styles.overlay} onClick={() => void handleClose()}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.title}>{memo.title}</span>
          <span className={styles.saveStatus}>
            {saveStatus === 'saving' && 'Saving…'}
            {saveStatus === 'saved' && 'Saved'}
            {saveStatus === 'error' && 'Save failed'}
          </span>
          <button className={styles.doneBtn} onClick={() => void handleClose()}>
            Done
          </button>
        </div>

        {findOpen && (
          <FindBar
            query={findQuery}
            onQueryChange={setFindQuery}
            matchCount={matchCount}
            activeMatchIndex={activeMatchIndex}
            onNext={goToNext}
            onPrev={goToPrev}
            onClose={() => setFindOpen(false)}
          />
        )}

        {/* Editor — always visible; FindBar floats on top */}
        <div className={styles.body}>
          <div className={styles.editorContent}>
            <EditorContent editor={editor} />
          </div>
        </div>
        <TiptapBubbleMenu editor={editor} />
      </div>
    </div>,
    document.body
  )
}
