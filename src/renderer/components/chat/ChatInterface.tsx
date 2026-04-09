import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import styles from './ChatInterface.module.css'
import { api } from '../../api'

export interface ContextOption {
  type: 'company' | 'contact'
  id: string
  name: string
}

interface ChatInterfaceProps {
  meetingId?: string // If provided, queries single meeting. Otherwise queries all meetings.
  meetingIds?: string[] // If provided, queries these specific meetings (search results).
  companyId?: string // If provided, queries company context (meetings, emails, files).
  contactId?: string // If provided, queries contact context (meetings, emails, notes).
  entityName?: string // Display name shown in context label (company/contact name).
  contextOptions?: ContextOption[] // If provided, shows a context switcher chip in floating mode.
  placeholder?: string
  fillHeight?: boolean // If true, container expands to fill available space
  compact?: boolean // If true, hides empty state text — just shows the input bar
  floating?: boolean // If true, renders as a fixed bottom bar with a pop-up overlay for responses
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

export default function ChatInterface({ meetingId, meetingIds, companyId, contactId, entityName, contextOptions, placeholder, fillHeight = false, compact = false, floating = false }: ChatInterfaceProps) {
  const contextId = companyId ? `company:${companyId}` : contactId ? `contact:${contactId}` : meetingIds ? 'search-results' : (meetingId ?? 'global')

  const storedMessages = useChatStore((s) => s.conversations[contextId]?.messages)
  const messages = useMemo(() => storedMessages ?? EMPTY_MESSAGES, [storedMessages])
  const addMessage = useChatStore((s) => s.addMessage)

  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [floatingPanelOpen, setFloatingPanelOpen] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [activeContext, setActiveContext] = useState<'meeting' | ContextOption>('meeting')
  const [contextDropdownOpen, setContextDropdownOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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

  // Escape collapses the floating panel
  useEffect(() => {
    if (!floating) return
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape' && floatingPanelOpen) {
        setFloatingPanelOpen(false)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [floating, floatingPanelOpen])

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

  function handleContextSwitch(next: 'meeting' | ContextOption) {
    if (next === activeContext || (next !== 'meeting' && activeContext !== 'meeting' && next.id === activeContext.id)) return
    setActiveContext(next)
    setContextDropdownOpen(false)
    const label = next === 'meeting' ? 'This meeting' : `All ${next.name} meetings`
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
    if (contextOptions && activeContext !== 'meeting') {
      if (activeContext.type === 'company') {
        api.invoke(IPC_CHANNELS.COMPANY_CHAT_ABORT)
      } else {
        api.invoke(IPC_CHANNELS.CONTACT_CHAT_ABORT)
      }
    } else if (companyId) {
      api.invoke(IPC_CHANNELS.COMPANY_CHAT_ABORT)
    } else if (contactId) {
      api.invoke(IPC_CHANNELS.CONTACT_CHAT_ABORT)
    } else {
      api.invoke(IPC_CHANNELS.CHAT_ABORT)
    }
  }, [contextOptions, activeContext, companyId, contactId])

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
    if (floating) setFloatingPanelOpen(true)

    try {
      let response: string
      if (contextOptions && activeContext !== 'meeting') {
        if (activeContext.type === 'company') {
          response = await api.invoke<string>(IPC_CHANNELS.COMPANY_CHAT_QUERY, { companyId: activeContext.id, question })
        } else {
          response = await api.invoke<string>(IPC_CHANNELS.CONTACT_CHAT_QUERY, { contactId: activeContext.id, question })
        }
      } else if (companyId) {
        response = await api.invoke<string>(
          IPC_CHANNELS.COMPANY_CHAT_QUERY,
          { companyId, question }
        )
      } else if (contactId) {
        response = await api.invoke<string>(
          IPC_CHANNELS.CONTACT_CHAT_QUERY,
          { contactId, question }
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
        response = await api.invoke<string>(IPC_CHANNELS.CHAT_QUERY_GLOBAL, question, ipcAttachments)
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
  }, [input, attachments, isLoading, meetingId, meetingIds, companyId, contactId, contextId, addMessage, floating, contextOptions, activeContext])

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
  const defaultPlaceholder = 'Ask anything…'
  const containerClass = fillHeight ? `${styles.container} ${styles.fillHeight}` : styles.container

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
              ? <ReactMarkdown>{msg.content}</ReactMarkdown>
              : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
          </div>
        </div>
        )
      )}
      {isLoading && streamedContent && (
        <div className={styles.message}>
          <span className={`${styles.messageRole} ${styles.assistant}`}>AI</span>
          <div className={`${styles.messageContent} ${styles.streaming}`}>
            <ReactMarkdown>{streamedContent}</ReactMarkdown>
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

  // Shared drop zone + input row builder
  const makeInputSection = (rowClass: string) => (
    <div
      className={`${styles.dropZone} ${isDragOver ? styles.dragOver : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragOver && <div className={styles.dropOverlay}>Drop files or screenshots here</div>}
      {attachmentChips}
      <div className={rowClass}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          data-chat-shortcut="true"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => { if (floating && messages.length > 0) setFloatingPanelOpen(true) }}
          placeholder={placeholder || defaultPlaceholder}
          disabled={isLoading}
          rows={1}
        />
        {floating && hasThread && !floatingPanelOpen && (
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
  )

  if (floating) {
    const showPanel = floatingPanelOpen && (messages.length > 0 || isLoading)
    return createPortal(
      <div className={styles.floatingRoot}>
        <div className={`${styles.floatingWidget} ${showPanel ? styles.floatingWidgetExpanded : ''}`}>
          <div className={styles.floatingPanel}>
            <div className={styles.floatingPanelHeader}>
              <div className={styles.floatingPanelTitleWrap}>
                <span className={styles.floatingPanelTitle}>Ask AI</span>
                {meetingId ? (
                  <div className={styles.contextChipWrap} ref={contextDropdownRef}>
                    <button
                      className={styles.contextChip}
                      onClick={() => contextOptions?.length ? setContextDropdownOpen(v => !v) : undefined}
                      aria-haspopup={contextOptions?.length ? 'listbox' : undefined}
                    >
                      {activeContext === 'meeting'
                        ? 'This meeting'
                        : `All ${activeContext.name} meetings`}
                      {contextOptions?.length ? <span className={styles.contextChevron}>▾</span> : null}
                    </button>
                    {contextDropdownOpen && contextOptions && (
                      <div className={styles.contextDropdown} role="listbox">
                        <button
                          className={`${styles.contextDropdownItem} ${activeContext === 'meeting' ? styles.contextDropdownItemActive : ''}`}
                          onClick={() => handleContextSwitch('meeting')}
                        >
                          This meeting
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
                ) : (companyId || contactId) && entityName ? (
                  <span className={styles.contextLabel}>
                    {entityName} · {companyId ? 'meetings, emails & files' : 'meetings, emails & notes'}
                  </span>
                ) : (!companyId && !contactId && !meetingId && !meetingIds) ? (
                  <span className={styles.contextLabel}>All meetings</span>
                ) : null}
              </div>
              <button
                className={styles.floatingPanelClose}
                onClick={() => setFloatingPanelOpen(false)}
                title="Collapse"
              >
                ▾
              </button>
            </div>
            <div className={styles.floatingMessages}>
              {messagesContent}
            </div>
            {error && <div className={`${styles.error} ${styles.floatingError}`}>{error}</div>}
          </div>
          <div className={styles.floatingInputArea}>
            {makeInputSection(styles.floatingInputRow)}
          </div>
        </div>
      </div>,
      document.body
    )
  }

  return (
    <div className={containerClass}>
      {messages.length > 0 && (
        <div className={styles.messages}>
          {messagesContent}
        </div>
      )}

      {!compact && messages.length === 0 && !isLoading && (
        <div className={styles.emptyState}>
          {companyId
            ? `Ask questions about ${entityName ?? 'this company'} — meetings, emails & files.`
            : contactId
              ? `Ask questions about ${entityName ?? 'this contact'} — meetings, emails & notes.`
              : meetingIds
                ? 'Ask questions across the meetings in your search results.'
                : meetingId
                  ? 'Ask questions about this meeting\'s transcript and notes.'
                  : 'Ask questions across all your meeting transcripts.'}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {makeInputSection(styles.inputRow)}
    </div>
  )
}
