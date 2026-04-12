import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Stable plugin array — used on every ReactMarkdown instance to ensure GFM
// features (tables, strikethrough, task lists) are consistently enabled.
const MARKDOWN_PLUGINS = [remarkGfm]
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import type { ContextOption } from '../../../shared/types/chat'
import styles from './ChatInterface.module.css'
import { api } from '../../api'

export type { ContextOption }

interface ChatInterfaceProps {
  meetingId?: string        // If provided, queries single meeting. Otherwise queries all meetings.
  meetingIds?: string[]     // If provided, queries these specific meetings (search results).
  contextOptions?: ContextOption[] // If provided, shows a context switcher chip.
  placeholder?: string
}

interface PendingAttachment {
  name: string
  mimeType: string
  type: 'image' | 'text'
  data: string // text content, or base64 without data: prefix for images
  previewUrl?: string // object URL for image thumbnails
}

// Stable empty array to avoid infinite re-renders
const EMPTY_MESSAGES: { role: 'user' | 'assistant' | 'system'; content: string }[] = []

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.split(',')[1]) // strip "data:mime;base64," prefix
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function processFile(file: File): Promise<PendingAttachment | null> {
  try {
    if (file.type.startsWith('image/')) {
      const data = await readFileAsBase64(file)
      const previewUrl = URL.createObjectURL(file)
      return { name: file.name, mimeType: file.type, type: 'image', data, previewUrl }
    } else {
      const text = await readFileAsText(file)
      return { name: file.name, mimeType: file.type || 'text/plain', type: 'text', data: text }
    }
  } catch {
    return null
  }
}

function parseChatError(errStr: string): string {
  // Try to extract Anthropic API error message from the JSON blob
  try {
    const jsonMatch = errStr.match(/\{.*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const msg: string | undefined = parsed?.error?.message
      if (msg) {
        if (msg.toLowerCase().includes('credit balance')) {
          return 'Your Anthropic API credit balance is too low. Please add credits at console.anthropic.com → Billing.'
        }
        return msg
      }
    }
  } catch {
    // fall through to raw string handling
  }
  if (errStr.toLowerCase().includes('credit balance')) {
    return 'Your Anthropic API credit balance is too low. Please add credits at console.anthropic.com → Billing.'
  }
  if (errStr.includes('API key not configured')) {
    return 'Claude API key is not configured. Go to Settings to add it.'
  }
  if (errStr.includes('401') || errStr.toLowerCase().includes('invalid api key') || errStr.toLowerCase().includes('authentication')) {
    return 'Invalid API key. Please check your Claude API key in Settings.'
  }
  return 'Something went wrong. Please try again.'
}

export default function ChatInterface({ meetingId, meetingIds, contextOptions, placeholder }: ChatInterfaceProps) {
  // Floating widget state machine:
  //   COLLAPSED → pill fixed at bottom of screen
  //               pointer-events: none on root, all on widget
  //               bg content fully visible and accessible
  //   EXPANDED  → panel grows UPWARD above input bar
  //               NO backdrop, NO centering, NO width change
  //               bg content still fully visible and accessible
  //   Opened by: handleSubmit, onFocus (messages exist)
  //   Closed by: ⌄ button (minimize), ✕ button (minimize + clear),
  //              Escape key, click outside widget (minimize, no clear)
  //              All close paths work even during streaming.
  //
  //   Escape / click-outside priority:
  //     contextDropdownOpen=true  → close dropdown only, panel stays
  //     contextDropdownOpen=false → close panel (minimize)
  //
  //   ✕ button (when streaming): calls handleStop() first to abort,
  //     clears streamedContentRef.current to prevent orphan partial message,
  //     then clearConversation(contextId)
  const [floatingPanelOpen, setFloatingPanelOpen] = useState(false)

  // activeContext: which entity scope is active in the context chip dropdown.
  // Syncs via useEffect when meetingId/contextOptions change (navigation).
  const [activeContext, setActiveContext] = useState<'meeting' | ContextOption>('meeting')
  const [contextDropdownOpen, setContextDropdownOpen] = useState(false)

  // Sync activeContext when page context changes (e.g., navigating to a new entity page).
  // Without this, activeContext stays stale after navigation.
  useEffect(() => {
    if (!meetingId && contextOptions?.[0]) {
      setActiveContext(contextOptions[0])    // default to entity on detail pages
    } else if (!meetingId) {
      setActiveContext('meeting')            // reset to Global on list pages
    }
    // meetingId case: keep 'meeting' (This meeting is the correct default)
  }, [meetingId, contextOptions])

  // contextId: key for the chat.store conversations map.
  // Derived from activeContext when an entity option is selected; otherwise from meetingId/meetingIds.
  const contextId = activeContext !== 'meeting'
    ? `${activeContext.type}:${activeContext.id}`
    : meetingIds ? 'search-results'
    : meetingId ?? 'global-all'

  const storedMessages = useChatStore((s) => s.conversations[contextId]?.messages)
  const messages = useMemo(() => storedMessages ?? EMPTY_MESSAGES, [storedMessages])
  const addMessage = useChatStore((s) => s.addMessage)
  const clearConversation = useChatStore((s) => s.clearConversation)

  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const dragCounterRef = useRef(0)
  const contextDropdownRef = useRef<HTMLDivElement>(null)

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamedContent])

  // Listen for streaming progress
  useEffect(() => {
    if (!isLoading) return

    const unsub = api.on(IPC_CHANNELS.CHAT_PROGRESS, (chunk: unknown) => {
      if (chunk === null) {
        setStreamedContent('')
        return
      }
      setStreamedContent((prev) => prev + String(chunk))
    })

    return unsub
  }, [isLoading])

  // Escape: close dropdown first, then modal on second press
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (contextDropdownOpen) {
        setContextDropdownOpen(false)
        return
      }
      if (floatingPanelOpen) {
        setFloatingPanelOpen(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [contextDropdownOpen, floatingPanelOpen])

  // Close context dropdown on click outside
  useEffect(() => {
    if (!contextDropdownOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (contextDropdownRef.current && !contextDropdownRef.current.contains(e.target as Node)) {
        setContextDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextDropdownOpen])

  // Click outside widget: mirrors Escape priority — close dropdown first, then minimize panel.
  // Uses floatingPanelOpen/isLoading/messages directly (showPanel is derived below JSX scope).
  useEffect(() => {
    if (!(floatingPanelOpen && (messages.length > 0 || isLoading))) return
    function handleClickOutside(e: MouseEvent) {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        if (contextDropdownOpen) {
          setContextDropdownOpen(false)
        } else {
          setFloatingPanelOpen(false)
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [floatingPanelOpen, messages.length, isLoading, contextDropdownOpen])

  function handleContextSwitch(next: 'meeting' | ContextOption) {
    if (next === activeContext || (next !== 'meeting' && activeContext !== 'meeting' && next.id === activeContext.id)) return
    setActiveContext(next)
    setContextDropdownOpen(false)
    const label = next === 'meeting'
      ? (meetingId ? 'This meeting' : 'Global')
      : `All ${next.name} meetings`
    addMessage(contextId, { role: 'system' as const, content: `Context: ${label}` })
  }

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const streamedContentRef = useRef('')
  useEffect(() => {
    streamedContentRef.current = streamedContent
  }, [streamedContent])

  const addAttachments = useCallback(async (files: File[]) => {
    const results = await Promise.all(files.map(processFile))
    const valid = results.filter((r): r is PendingAttachment => r !== null)
    setAttachments((prev) => [...prev, ...valid])
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const next = [...prev]
      const removed = next.splice(index, 1)[0]
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return next
    })
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) addAttachments(files)
  }, [addAttachments])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addAttachments(files)
    }
  }, [addAttachments])

  const handleStop = useCallback(() => {
    if (activeContext !== 'meeting') {
      if (activeContext.type === 'company') {
        api.invoke(IPC_CHANNELS.COMPANY_CHAT_ABORT)
      } else {
        api.invoke(IPC_CHANNELS.CONTACT_CHAT_ABORT)
      }
    } else if (meetingId) {
      api.invoke(IPC_CHANNELS.CHAT_ABORT)
    } else {
      api.invoke(IPC_CHANNELS.CHAT_ABORT_ALL)
    }
  }, [activeContext, meetingId])

  const handleSubmit = useCallback(async () => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return

    const question = input.trim()
    const currentAttachments = [...attachments]

    // Build display string: question + 📎 filenames
    const attachmentNames = currentAttachments.map((a) => a.name).join(', ')
    const displayContent = attachmentNames
      ? question ? `${question}\n\n📎 ${attachmentNames}` : `📎 ${attachmentNames}`
      : question

    setInput('')
    setError(null)
    setStreamedContent('')
    streamedContentRef.current = ''
    setAttachments([])
    currentAttachments.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Strip previewUrl before sending over IPC
    const ipcAttachments = currentAttachments.length > 0
      ? currentAttachments.map(({ name, mimeType, type, data }) => ({ name, mimeType, type, data }))
      : undefined

    addMessage(contextId, { role: 'user', content: displayContent })
    setIsLoading(true)
    setFloatingPanelOpen(true)

    try {
      let response: string
      if (activeContext !== 'meeting') {
        // Entity context selected via dropdown
        response = await api.invoke<string>(
          activeContext.type === 'company' ? IPC_CHANNELS.COMPANY_CHAT_QUERY : IPC_CHANNELS.CONTACT_CHAT_QUERY,
          activeContext.type === 'company'
            ? { companyId: activeContext.id, question }
            : { contactId: activeContext.id, question }
        )
      } else if (meetingIds) {
        response = await api.invoke<string>(
          IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
          meetingIds,
          question,
          ipcAttachments
        )
      } else if (meetingId) {
        response = await api.invoke<string>(
          IPC_CHANNELS.CHAT_QUERY_MEETING,
          meetingId,
          question,
          ipcAttachments
        )
      } else {
        response = await api.invoke<string>(
          IPC_CHANNELS.CHAT_QUERY_ALL,
          { question, attachments: ipcAttachments }
        )
      }

      addMessage(contextId, { role: 'assistant', content: response })

      if (meetingId && activeContext === 'meeting') {
        const allMessages = useChatStore.getState().conversations[contextId]?.messages
        if (allMessages) {
          api.invoke(IPC_CHANNELS.MEETING_SAVE_CHAT, meetingId, allMessages)
        }
      }
    } catch (err) {
      const errStr = String(err)
      if (errStr.includes('abort') || errStr.includes('Abort')) {
        const partial = streamedContentRef.current
        if (partial) {
          addMessage(contextId, { role: 'assistant', content: partial })
        }
      } else {
        setError(parseChatError(errStr))
      }
    } finally {
      setIsLoading(false)
      setStreamedContent('')
    }
  }, [input, attachments, isLoading, meetingId, meetingIds, contextId, addMessage, contextOptions, activeContext])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const hasThread = messages.length > 0

  // Context-aware placeholder — derived from props, no extra store subscription
  const defaultPlaceholder = useMemo(() => {
    if (contextOptions?.[0]) return `Ask about ${contextOptions[0].name}…`
    if (meetingId) return 'Ask about this meeting…'
    return 'Ask anything…'
  }, [contextOptions, meetingId])

  const messagesContent = (
    <>
      {messages.map((msg, i) =>
        msg.role === 'system' ? (
          <div key={i} className={styles.contextDivider}>
            <span className={styles.contextDividerLabel}>{msg.content}</span>
          </div>
        ) : (
        <div key={i} className={styles.message}>
          <span className={`${styles.messageRole} ${styles[msg.role]}`}>
            {msg.role === 'user' ? 'You' : 'AI'}
          </span>
          <div className={styles.messageContent}>
            {msg.role === 'assistant'
              ? <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{msg.content}</ReactMarkdown>
              : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
          </div>
        </div>
        )
      )}
      {isLoading && streamedContent && (
        <div className={styles.message}>
          <span className={`${styles.messageRole} ${styles.assistant}`}>AI</span>
          <div className={`${styles.messageContent} ${styles.streaming}`}>
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{streamedContent}</ReactMarkdown>
          </div>
        </div>
      )}
      {isLoading && !streamedContent && (
        <div className={styles.message}>
          <span className={`${styles.messageRole} ${styles.assistant}`}>AI</span>
          <div className={`${styles.messageContent} ${styles.streaming}`}>Thinking...</div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </>
  )

  const attachmentChips = attachments.length > 0 && (
    <div className={styles.attachmentsRow}>
      {attachments.map((att, i) => (
        <div key={i} className={styles.attachmentChip}>
          {att.type === 'image' && att.previewUrl
            ? <img src={att.previewUrl} className={styles.attachmentThumb} alt="" />
            : <span className={styles.attachmentIcon}>📄</span>
          }
          <span className={styles.attachmentName} title={att.name}>{att.name}</span>
          <button className={styles.attachmentRemove} onClick={() => removeAttachment(i)} title="Remove">×</button>
        </div>
      ))}
    </div>
  )

  // Context chip label: "This meeting" when on a meeting page, "Global" otherwise
  const meetingLabel = meetingId ? 'This meeting' : 'Global'

  const showPanel = floatingPanelOpen && (messages.length > 0 || isLoading)

  return createPortal(
    <div className={styles.floatingRoot}>
      <div
        ref={widgetRef}
        className={`${styles.floatingWidget} ${showPanel ? styles.floatingWidgetExpanded : ''}`}
      >
        <div className={styles.floatingPanel}>
          <div className={styles.floatingPanelHeader}>
            <div className={styles.floatingPanelTitleWrap}>
              <span className={styles.floatingPanelTitle}>Ask AI</span>
              {(meetingId || contextOptions?.length) ? (
                <div className={styles.contextChipWrap} ref={contextDropdownRef}>
                  <button
                    className={styles.contextChip}
                    onClick={() => contextOptions?.length ? setContextDropdownOpen(v => !v) : undefined}
                    aria-haspopup={contextOptions?.length ? 'listbox' : undefined}
                  >
                    {activeContext === 'meeting'
                      ? meetingLabel
                      : `All ${activeContext.name} meetings`}
                    {contextOptions?.length ? <span className={styles.contextChevron}>▾</span> : null}
                  </button>
                  {contextDropdownOpen && contextOptions && (
                    <div className={styles.contextDropdown} role="listbox">
                      <button
                        className={`${styles.contextDropdownItem} ${activeContext === 'meeting' ? styles.contextDropdownItemActive : ''}`}
                        onClick={() => handleContextSwitch('meeting')}
                      >
                        {meetingLabel}
                      </button>
                      {contextOptions.map(opt => (
                        <button
                          key={opt.id}
                          className={`${styles.contextDropdownItem} ${activeContext !== 'meeting' && (activeContext as ContextOption).id === opt.id ? styles.contextDropdownItemActive : ''}`}
                          onClick={() => handleContextSwitch(opt)}
                        >
                          {opt.type === 'company' ? '🏢' : '👤'} All {opt.name} meetings
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className={styles.floatingPanelActions}>
              <button
                className={styles.floatingPanelClose}
                onClick={() => setFloatingPanelOpen(false)}
                title="Minimize"
              >
                ⌄
              </button>
              <button
                className={styles.floatingPanelClose}
                onClick={() => {
                  if (isLoading) {
                    handleStop()
                    streamedContentRef.current = '' // prevent partial re-add after abort
                  }
                  setStreamedContent('')
                  setFloatingPanelOpen(false)
                  clearConversation(contextId)
                }}
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>
          <div className={styles.floatingMessages}>
            {messagesContent}
          </div>
          {error && <div className={`${styles.error} ${styles.floatingError}`}>{error}</div>}
        </div>
        <div className={styles.floatingInputArea}>
          <div
            className={`${styles.dropZone} ${isDragOver ? styles.dragOver : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {isDragOver && <div className={styles.dropOverlay}>Drop files or screenshots here</div>}
            {attachmentChips}
            <div className={styles.floatingInputRow}>
              <textarea
                ref={textareaRef}
                className={styles.input}
                data-chat-shortcut="true"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => { if (messages.length > 0) setFloatingPanelOpen(true) }}
                placeholder={placeholder || defaultPlaceholder}
                disabled={isLoading}
                rows={1}
              />
              {hasThread && !floatingPanelOpen && (
                <span className={styles.threadBadge} aria-hidden />
              )}
              <button
                className={`${styles.sendBtn} ${isLoading ? styles.stopBtn : ''}`}
                onClick={isLoading ? handleStop : handleSubmit}
                disabled={!isLoading && !input.trim() && attachments.length === 0}
              >
                {isLoading ? '\u25A0' : 'Ask'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
