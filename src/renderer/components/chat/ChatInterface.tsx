import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import styles from './ChatInterface.module.css'

interface ChatInterfaceProps {
  meetingId?: string // If provided, queries single meeting. Otherwise queries all meetings.
  meetingIds?: string[] // If provided, queries these specific meetings (search results).
  placeholder?: string
  fillHeight?: boolean // If true, container expands to fill available space
  compact?: boolean // If true, hides empty state text — just shows the input bar
}

// Stable empty array to avoid infinite re-renders
const EMPTY_MESSAGES: { role: 'user' | 'assistant'; content: string }[] = []

export default function ChatInterface({ meetingId, meetingIds, placeholder, fillHeight = false, compact = false }: ChatInterfaceProps) {
  // Use different context keys for different chat modes
  const contextId = meetingIds ? 'search-results' : (meetingId ?? 'global')

  const storedMessages = useChatStore((s) => s.conversations[contextId]?.messages)
  const messages = useMemo(() => storedMessages ?? EMPTY_MESSAGES, [storedMessages])
  const addMessage = useChatStore((s) => s.addMessage)

  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamedContent])

  // Listen for streaming progress
  useEffect(() => {
    if (!isLoading) return

    const unsub = window.api.on(IPC_CHANNELS.CHAT_PROGRESS, (chunk: unknown) => {
      if (chunk === null) {
        setStreamedContent('')
        return
      }
      setStreamedContent((prev) => prev + String(chunk))
    })

    return unsub
  }, [isLoading])

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const streamedContentRef = useRef('')

  // Keep ref in sync with state for abort handler
  useEffect(() => {
    streamedContentRef.current = streamedContent
  }, [streamedContent])

  const handleStop = useCallback(() => {
    window.api.invoke(IPC_CHANNELS.CHAT_ABORT)
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isLoading) return

    const question = input.trim()
    setInput('')
    setError(null)
    setStreamedContent('')
    streamedContentRef.current = ''

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Add user message to store
    addMessage(contextId, { role: 'user', content: question })
    setIsLoading(true)

    try {
      let response: string
      if (meetingIds) {
        response = await window.api.invoke<string>(
          IPC_CHANNELS.CHAT_QUERY_SEARCH_RESULTS,
          meetingIds,
          question
        )
      } else if (meetingId) {
        response = await window.api.invoke<string>(
          IPC_CHANNELS.CHAT_QUERY_MEETING,
          meetingId,
          question
        )
      } else {
        response = await window.api.invoke<string>(IPC_CHANNELS.CHAT_QUERY_GLOBAL, question)
      }

      // Add assistant message to store
      addMessage(contextId, { role: 'assistant', content: response })

      // Persist chat history for meeting-specific chats only
      if (meetingId) {
        const allMessages = useChatStore.getState().conversations[contextId]?.messages
        if (allMessages) {
          window.api.invoke(IPC_CHANNELS.MEETING_SAVE_CHAT, meetingId, allMessages)
        }
      }
    } catch (err) {
      const errStr = String(err)
      if (errStr.includes('abort') || errStr.includes('Abort')) {
        // Save partial streamed content as assistant message
        const partial = streamedContentRef.current
        if (partial) {
          addMessage(contextId, { role: 'assistant', content: partial })
        }
      } else {
        setError(errStr)
      }
    } finally {
      setIsLoading(false)
      setStreamedContent('')
    }
  }, [input, isLoading, meetingId, meetingIds, contextId, addMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const defaultPlaceholder = 'Ask anything...'

  const containerClass = fillHeight
    ? `${styles.container} ${styles.fillHeight}`
    : styles.container

  return (
    <div className={containerClass}>
      {messages.length > 0 && (
        <div className={styles.messages}>
          {messages.map((msg, i) => (
            <div key={i} className={styles.message}>
              <span className={`${styles.messageRole} ${styles[msg.role]}`}>
                {msg.role === 'user' ? 'You' : 'AI'}
              </span>
              <div className={styles.messageContent}>
                {msg.role === 'assistant'
                  ? <ReactMarkdown>{msg.content}</ReactMarkdown>
                  : msg.content}
              </div>
            </div>
          ))}
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
              <div className={`${styles.messageContent} ${styles.streaming}`}>
                Thinking...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {!compact && messages.length === 0 && !isLoading && (
        <div className={styles.emptyState}>
          {meetingIds
            ? 'Ask questions across the meetings in your search results.'
            : meetingId
              ? 'Ask questions about this meeting\'s transcript and notes.'
              : 'Ask questions across all your meeting transcripts.'}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          data-chat-shortcut="true"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || defaultPlaceholder}
          disabled={isLoading}
          rows={1}
        />
        <button
          className={`${styles.sendBtn} ${isLoading ? styles.stopBtn : ''}`}
          onClick={isLoading ? handleStop : handleSubmit}
          disabled={!isLoading && !input.trim()}
        >
          {isLoading ? '\u25A0' : 'Ask (Cmd+K)'}
        </button>
      </div>
    </div>
  )
}
