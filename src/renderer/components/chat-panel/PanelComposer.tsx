import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import { useChatStore } from '../../stores/chat.store'
import {
  processFiles,
  loadCyggieFile,
  revokePreview,
  toIPCAttachment,
  type PendingAttachment,
} from '../../lib/chat-attachments'
import type { ChatKind } from '../../lib/chat-channels'
import type { ChatAttachmentIPC } from '../../lib/chat-attachments'
import { ContextChip } from './ContextChip'
import ChatContextSizeBanner from './ChatContextSizeBanner'
import styles from './PanelComposer.module.css'

interface PanelComposerProps {
  /** Determined by the caller from current panelSession / pageContext. */
  kind: ChatKind
  /** "Including context: <name>" chip. Empty array hides chip. */
  contextOptions: import('../../../shared/types/chat').ContextOption[]
  activeContextId: string | null
  onContextChange: (option: import('../../../shared/types/chat').ContextOption | null) => void

  /** Hook handles. */
  isLoading: boolean
  send: (args: { kind: ChatKind; question: string; attachments?: ChatAttachmentIPC[] }) => Promise<void>
  abort: (kind: ChatKind) => Promise<void>

  /** Add the user's message to the thread (panel session). */
  appendUser: (content: string) => void

  /** Inline error from the streaming hook (or attachment caps, save-to-notes). */
  error: string | null
  onClearError: () => void

  /** "+ New chat" button click. The provider derives the new chat's context
   *  from the current pageContext at click time. */
  onNewChat: () => void

  /** When set, type a placeholder informed by the active context. */
  placeholder?: string

  /** Larger sizing for the full-screen route. */
  large?: boolean
}

/**
 * Composer surface — textarea + drop zone + send/abort + new-chat link.
 * Mounted ONCE inside ChatPanelRoot and portaled into the rail or full-screen
 * mount. Drafts persist via useChatPanelStore.draftBySession keyed by
 * openSessionId (or '__draft__' for not-yet-created chats).
 */
export function PanelComposer({
  kind,
  contextOptions,
  activeContextId,
  onContextChange,
  isLoading,
  send,
  abort,
  appendUser,
  error,
  onClearError,
  onNewChat,
  placeholder,
  large = false,
}: PanelComposerProps) {
  const openSessionId = useChatPanelStore((s) => s.openSessionId)
  const draftKey = openSessionId ?? '__draft__'
  const draft = useChatPanelStore((s) => s.draftBySession[draftKey] ?? '')
  const setDraft = useChatPanelStore((s) => s.setDraft)
  const clearDraft = useChatPanelStore((s) => s.clearDraft)
  const dismissedContextChips = useChatPanelStore((s) => s.dismissedContextChips)
  const dismissContextChip = useChatPanelStore((s) => s.dismissContextChip)
  const bumpAction = useChatPanelStore((s) => s.bumpAction)

  const panelSessionId = useChatStore((s) => s.panelSession?.sessionId ?? null)
  const dismissed = panelSessionId !== null && dismissedContextChips.has(panelSessionId)

  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach(revokePreview)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(draftKey, e.target.value)
      const el = e.target
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    },
    [draftKey, setDraft]
  )

  const addAttachments = useCallback(async (files: File[]) => {
    const { attachments: valid, errors } = await processFiles(files)
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid])
    if (errors.length > 0) {
      // Errors include "file too large" and "max 10 files per drop". Logged
      // for now; future polish can surface them inline alongside the streaming
      // error channel.
      console.warn('[chat-panel] attachment errors', errors)
    }
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-cyggie-file')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragCounterRef.current = 0
      setIsDragOver(false)

      const cyggieData = e.dataTransfer.getData('application/x-cyggie-file')
      if (cyggieData) {
        try {
          // PR2: payload carries `companyId` and `mimeType` so main can
          // auto-flag the file on first read. `id` is the flagged-file id
          // (Drive id or local path).
          const { id, companyId, name, mimeType } = JSON.parse(cyggieData) as {
            id: string
            companyId: string
            name: string
            mimeType?: string | null
          }
          if (!id || !companyId || !name) {
            console.warn('[panel-composer] cyggie-file drop missing required fields')
            return
          }
          void loadCyggieFile(id, companyId, name, mimeType).then((r) => {
            if (r.ok) setAttachments((prev) => [...prev, r.attachment])
          })
        } catch {
          /* ignore malformed */
        }
        return
      }

      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) void addAttachments(files)
    },
    [addAttachments]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = []
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        void addAttachments(files)
      }
    },
    [addAttachments]
  )

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const next = [...prev]
      const removed = next.splice(index, 1)[0]
      if (removed) revokePreview(removed)
      return next
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = draft.trim()
    if ((!trimmed && attachments.length === 0) || isLoading) return

    const currentAttachments = [...attachments]
    const ipcAttachments = currentAttachments.length > 0 ? currentAttachments.map(toIPCAttachment) : undefined

    // Build display content with attachment names appended
    const attachmentNames = currentAttachments.map((a) => a.name).join(', ')
    const displayContent = attachmentNames
      ? trimmed
        ? `${trimmed}\n\n📎 ${attachmentNames}`
        : `📎 ${attachmentNames}`
      : trimmed

    onClearError()
    clearDraft(draftKey)
    setAttachments([])
    currentAttachments.forEach(revokePreview)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    appendUser(displayContent)
    bumpAction()

    await send({ kind, question: trimmed, attachments: ipcAttachments })
    bumpAction()
  }, [draft, attachments, isLoading, kind, send, appendUser, bumpAction, clearDraft, draftKey, onClearError])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSubmit()
      } else if (e.key === 'Escape' && draft === '' && attachments.length === 0) {
        // Empty composer + Escape → close panel (handled by parent global key handler).
        // Don't preventDefault — let the global handler take it.
      }
    },
    [handleSubmit, draft, attachments.length]
  )

  const showChip = contextOptions.length > 0 && !dismissed

  // Banner only renders for company-scoped chat (other kinds get nothing).
  // companyId is the chat's pinned company id from the kind prop.
  const bannerCompanyId = kind.kind === 'company' ? kind.companyId : null

  return (
    <div className={`${styles.composer} ${large ? styles.composerLarge : ''}`}>
      <ChatContextSizeBanner companyId={bannerCompanyId} />

      {error && (
        <div className={styles.error}>
          {error}
          <button type="button" className={styles.errorDismiss} onClick={onClearError} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}

      {showChip && panelSessionId && (
        <ContextChip
          contextOptions={contextOptions}
          activeId={activeContextId}
          onSelect={onContextChange}
          onDismiss={() => dismissContextChip(panelSessionId)}
        />
      )}

      <div className={styles.actionsRow}>
        <button type="button" className={styles.newChatBtn} onClick={onNewChat} title="Start a new chat">
          + New chat
        </button>
      </div>

      <div
        className={`${styles.dropZone} ${isDragOver ? styles.dragOver : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragOver && <div className={styles.dropOverlay}>Drop files here</div>}

        {attachments.length > 0 && (
          <div className={styles.attachmentsRow}>
            {attachments.map((a, i) => (
              <div key={i} className={styles.attachmentChip}>
                {a.type === 'image' && a.previewUrl ? (
                  <img src={a.previewUrl} className={styles.attachmentThumb} alt="" />
                ) : (
                  <span className={styles.attachmentIcon}>📄</span>
                )}
                <span className={styles.attachmentName} title={a.name}>{a.name}</span>
                <button
                  type="button"
                  className={styles.attachmentRemove}
                  onClick={() => removeAttachment(i)}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.inputRow}>
          <textarea
            ref={textareaRef}
            className={styles.input}
            data-chat-shortcut="true"
            value={draft}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? 'Ask Cyggie anything…'}
            disabled={isLoading}
            rows={1}
          />
          <button
            type="button"
            className={`${styles.sendBtn} ${isLoading ? styles.stopBtn : ''}`}
            onClick={isLoading ? () => void abort(kind) : () => void handleSubmit()}
            disabled={!isLoading && !draft.trim() && attachments.length === 0}
            title={isLoading ? 'Stop' : 'Send'}
          >
            {isLoading ? '■' : '↑'}
          </button>
        </div>
      </div>
    </div>
  )
}
