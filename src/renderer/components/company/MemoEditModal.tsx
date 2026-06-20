/**
 * MemoEditModal — rich text editor modal for investment memos.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Explicit-save model (no autosave)                                │
 *   │                                                                   │
 *   │   mount ──► loadContent(memo.latestVersion.contentMarkdown)       │
 *   │                                                                   │
 *   │   user types ──► onUpdate → setContentDraft                       │
 *   │                  (no autosave; dirty pill shows "Unsaved")        │
 *   │                                                                   │
 *   │   user presses ⌘S or clicks Save ──► doSave(contentDraft)         │
 *   │                                       │                            │
 *   │                                       └─ savedContentRef = content │
 *   │                                          dirty=false                │
 *   │                                                                   │
 *   │   close (X / Esc / overlay click):                                │
 *   │     clean state    → onClose immediately                          │
 *   │     dirty state    → ConfirmDialog: Discard | Save | Cancel       │
 *   │                       Save → doSave → onClose                     │
 *   │                       Discard → onClose                           │
 *   │                       Cancel → return to editing                  │
 *   │                                                                   │
 *   │  Why no autosave: previous debounced-autosave model created       │
 *   │  spurious "blank-change-note" versions (v3+) because Tiptap's     │
 *   │  markdown serialization is non-deterministic enough that the      │
 *   │  spurious-save guard lost races. Explicit > clever.               │
 *   └──────────────────────────────────────────────────────────────────┘
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
import ConfirmDialog from '../common/ConfirmDialog'
import { useTiptapMarkdown } from '../../hooks/useTiptapMarkdown'
import { TABLE_EXTENSIONS } from '../../lib/tiptap-extensions'
import { FindHighlight } from '../../lib/find-highlight-extension'
import { useFindInPage } from '../../hooks/useFindInPage'
import { useTiptapFindHighlight } from '../../hooks/useTiptapFindHighlight'
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

  // Editor is created before useFindInPage so the find text can read its
  // plain-text content (offsets must align with FindHighlight's cursor walk).
  const { editor, loadContent } = useTiptapMarkdown({
    extensions: [StarterKit, Markdown, Link, ...TABLE_EXTENSIONS, FindHighlight],
    onUpdate: ({ editor: e }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mkd = (e as any).getMarkdown?.() ?? ''
      setContentDraft(mkd)
    },
  }, [memo.id])

  const {
    query: findQuery,
    setQuery: setFindQuery,
    matchCount,
    activeMatchIndex,
    matches: findMatches,
    goToNext,
    goToPrev,
  } = useFindInPage({
    // Feed editor.state.doc.textContent (NOT getText() — see find-highlight-extension.ts
    // header) so match offsets align with FindHighlight's cursor walk. Gated on findOpen
    // so we don't walk the whole doc on every keystroke while find is closed; the
    // contentDraft fallback is unused for matching then (query is empty).
    text: findOpen && editor ? editor.state.doc.textContent : contentDraft,
    isOpen: findOpen,
    onOpen: () => setFindOpen(true),
    onClose: () => setFindOpen(false),
    // Scope the active-match scroll to this editor so an underlying read-only
    // memo view (left with find open) isn't what scrolls, and center the match.
    scrollRoot: editor?.view.dom ?? null,
  })

  // Push matches into the editor's FindHighlight extension as <mark> decorations.
  useTiptapFindHighlight(editor, findMatches, activeMatchIndex)

  // Pre-populate query when opened from view mode with an active search
  // useRef avoids ESLint exhaustive-deps warning — intentional initial-value-only pattern
  const initialFindQueryRef = useRef(initialFindQuery)
  useEffect(() => {
    if (initialFindQueryRef.current) setFindQuery(initialFindQueryRef.current)
  }, [setFindQuery]) // setFindQuery is a stable useState setter — effectively runs once

  // Load content on mount
  useEffect(() => {
    loadContent(initialContent)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Dirty state: contentDraft differs from the last-saved snapshot. Drives
  // the "Unsaved" pill, Save button enabled-state, and close-confirm dialog.
  const isDirty = contentDraft !== savedContentRef.current

  // Close-confirm dialog state for the dirty-close path.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  async function doSave(content: string): Promise<boolean> {
    if (saveStatus === 'saving') return false
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
      return true
    } catch {
      setSaveStatus('error')
      return false
    }
  }

  const handleSave = useCallback(() => {
    if (!isDirty) return
    void doSave(contentDraft)
  }, [isDirty, contentDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close intent: if clean, close immediately. If dirty, open the
  // Discard/Save/Cancel confirm dialog.
  const requestClose = useCallback(() => {
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
    if (!isDirty) {
      onClose()
      return
    }
    setConfirmDiscardOpen(true)
  }, [isDirty, onClose])

  // From within the confirm dialog: SAVE → save then close on success.
  const handleConfirmSaveAndClose = useCallback(async () => {
    const saved = await doSave(contentDraft)
    if (saved) {
      setConfirmDiscardOpen(false)
      onClose()
    }
    // If save fails, leave the dialog open with the save-failed pill behind.
  }, [contentDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  // From within the confirm dialog: DISCARD → close without saving.
  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscardOpen(false)
    onClose()
  }, [onClose])

  // Keyboard: Escape closes (with dirty-confirm); ⌘S / Ctrl+S saves.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘S / Ctrl+S — save (preventDefault so the OS/browser doesn't capture it).
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        // Don't fire save while find bar has focus (let it handle its own
        // shortcuts in the future without conflict).
        if (findOpenRef.current) return
        handleSave()
        return
      }
      if (e.key === 'Escape') {
        // If find bar is open, let FindBar's own Escape handler close it first.
        if (findOpenRef.current) return
        // If the confirm dialog is open, let IT handle Escape.
        if (confirmDiscardOpen) return
        requestClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleSave, requestClose, confirmDiscardOpen])

  return createPortal(
    <div className={styles.overlay} onClick={requestClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.title}>{memo.title}</span>
          <span className={`${styles.saveStatus} ${isDirty && saveStatus !== 'saving' ? styles.saveStatusDirty : ''} ${saveStatus === 'error' ? styles.saveStatusError : ''}`}>
            {saveStatus === 'saving' ? 'Saving…' :
             saveStatus === 'error' ? 'Save failed — retry' :
             isDirty ? 'Unsaved changes' :
             saveStatus === 'saved' ? 'Saved' : ''}
          </span>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={!isDirty || saveStatus === 'saving'}
            title="Save (⌘S)"
          >
            Save
          </button>
          <button className={styles.doneBtn} onClick={requestClose}>
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

      <ConfirmDialog
        open={confirmDiscardOpen}
        title="Unsaved changes"
        message="You have unsaved changes. Save them, discard them, or keep editing?"
        cancelLabel="Keep editing"
        secondaryLabel="Discard"
        confirmLabel="Save"
        onCancel={() => setConfirmDiscardOpen(false)}
        onSecondary={handleConfirmDiscard}
        onConfirm={() => void handleConfirmSaveAndClose()}
        errorMessage={saveStatus === 'error' ? 'Save failed — please retry.' : null}
      />
    </div>,
    document.body
  )
}
