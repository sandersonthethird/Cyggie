import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import styles from './ChatInterface.module.css'

interface ChatInterfaceProps {
  meetingId?: string // If provided, queries single meeting. Otherwise queries all meetings.
  meetingIds?: string[] // If provided, queries these specific meetings (search results).
  placeholder?: string
  fillHeight?: boolean // If true, container expands to fill available space
}

// Stable empty array to avoid infinite re-renders
const EMPTY_MESSAGES: { role: 'user' | 'assistant'; content: string }[] = []

export default function ChatInterface({ meetingId, meetingIds, placeholder, fillHeight = false }: ChatInterfaceProps) {
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

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isLoading) return

    const question = input.trim()
    setInput('')
    setError(null)
    setStreamedContent('')

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
      setError(String(err))
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

  const defaultPlaceholder = meetingIds
    ? 'Ask about these search results...'
    : meetingId
      ? 'Ask about this meeting...'
      : 'Ask about your meetings...'

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
              <div className={styles.messageContent}>{msg.content}</div>
            </div>
          ))}
          {isLoading && streamedContent && (
            <div className={styles.message}>
              <span className={`${styles.messageRole} ${styles.assistant}`}>AI</span>
              <div className={`${styles.messageContent} ${styles.streaming}`}>
                {streamedContent}
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

      {messages.length === 0 && !isLoading && (
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
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || defaultPlaceholder}
          disabled={isLoading}
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={handleSubmit}
          disabled={!input.trim() || isLoading}
        >
          {isLoading ? 'Asking...' : 'Ask'}
        </button>
      </div>
    </div>
  )
}
