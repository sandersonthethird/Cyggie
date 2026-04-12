'use client'

/*
 * FloatingChatWidget — state machine
 *
 * COLLAPSED (default)
 *   │   [user submits OR focuses input while messages exist]
 *   ▼
 * EXPANDED (panel open, messages visible, max-height: 55vh)
 *   │   [⌄ minimize / Escape / click-outside]
 *   ▼
 * COLLAPSED (messages kept in state)
 *   │   [✕ close]
 *   ▼
 * COLLAPSED + messages cleared
 *
 * AbortController: new AbortController() per submit, aborted on Stop button
 * click or component unmount (useEffect cleanup).
 *
 * SSE data flow:
 *   fetch(apiPath, { signal }) → ReadableStream
 *     └→ buffer + split on '\n'
 *          └→ data: {"text":"..."} events
 *               └→ accumulated → setStreamedContent (live)
 *                    └→ committed to messages[] on [DONE] or abort
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  token: string
  apiPath: string
  placeholder?: string
}

export default function FloatingChatWidget({ token, apiPath, placeholder = 'Ask a question…' }: Props) {
  const [mounted, setMounted] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setMounted(true) }, [])

  // Abort in-flight request on unmount
  useEffect(() => {
    return () => { abortControllerRef.current?.abort() }
  }, [])

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamedContent])

  // Auto-resize textarea (max 120px)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [input])

  // Click-outside minimizes panel
  useEffect(() => {
    if (!isExpanded) return
    function onMouseDown(e: MouseEvent) {
      if (widgetRef.current && !widgetRef.current.contains(e.target as Node)) {
        setIsExpanded(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [isExpanded])

  // Escape minimizes panel
  useEffect(() => {
    if (!isExpanded) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsExpanded(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isExpanded])

  const handleSubmit = useCallback(async () => {
    const question = input.trim()
    if (!question || isLoading) return

    setInput('')
    setError(null)
    setIsLoading(true)
    setStreamedContent('')
    setIsExpanded(true)

    const userMessage: Message = { role: 'user', content: question }
    // Capture current messages for history before state update
    const historySnapshot = messages

    setMessages((prev) => [...prev, userMessage])

    const controller = new AbortController()
    abortControllerRef.current = controller

    let accumulated = ''

    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          question,
          history: historySnapshot.slice(-10),
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || 'Chat request failed')
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data)
            if (parsed.error) throw new Error(parsed.error)
            if (parsed.text) {
              accumulated += parsed.text
              setStreamedContent(accumulated)
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue // skip partial JSON
            throw e
          }
        }
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }])
      setStreamedContent('')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User stopped — commit whatever streamed so far
        if (accumulated) {
          setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }])
        }
        setStreamedContent('')
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    } finally {
      setIsLoading(false)
    }
  }, [input, isLoading, token, messages, apiPath])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleStop = () => { abortControllerRef.current?.abort() }
  const handleMinimize = () => setIsExpanded(false)
  const handleClose = () => {
    setIsExpanded(false)
    setMessages([])
    setError(null)
    setStreamedContent('')
  }

  const hasMessages = messages.length > 0

  if (!mounted) return null

  const widget = (
    <div
      ref={widgetRef}
      data-floating-chat=""
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 560,
        maxWidth: 'calc(100% - 40px)',
        zIndex: 1000,
        borderRadius: 16,
        boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
        background: '#fff',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Expanded panel */}
      {isExpanded && (
        <>
          {/* Panel header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid #e5e7eb',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Ask AI</span>
            <div style={{ display: 'flex', gap: 2 }}>
              <button
                onClick={handleMinimize}
                title="Minimize"
                style={{ padding: '4px 8px', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, lineHeight: 1, borderRadius: 4 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#374151')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#9ca3af')}
              >
                ⌄
              </button>
              <button
                onClick={handleClose}
                title="Close"
                style={{ padding: '4px 8px', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14, lineHeight: 1, borderRadius: 4 }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#374151')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#9ca3af')}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Messages list */}
          <div style={{
            overflowY: 'auto',
            maxHeight: '55vh',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}>
            {messages.map((msg, i) => (
              <div key={i}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: '#9ca3af',
                  marginBottom: 3,
                  letterSpacing: '0.05em',
                }}>
                  {msg.role === 'user' ? 'You' : 'AI'}
                </div>
                <div style={{ fontSize: 14, color: '#111827', lineHeight: 1.55 }}>
                  {msg.role === 'user' ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                  ) : (
                    <div className="summary-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Streaming / thinking indicator */}
            {isLoading && (
              <div>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: '#9ca3af',
                  marginBottom: 3,
                  letterSpacing: '0.05em',
                }}>
                  AI
                </div>
                <div style={{ fontSize: 14, color: '#111827', lineHeight: 1.55 }}>
                  {streamedContent ? (
                    <div className="summary-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedContent}</ReactMarkdown>
                    </div>
                  ) : (
                    <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Thinking…</span>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div style={{
                padding: '8px 12px',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 8,
                fontSize: 13,
                color: '#dc2626',
              }}>
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </>
      )}

      {/* Input row — always visible */}
      <div style={{ position: 'relative', borderTop: isExpanded ? '1px solid #e5e7eb' : 'none' }}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (hasMessages) setIsExpanded(true) }}
          disabled={isLoading}
          placeholder={placeholder}
          style={{
            width: '100%',
            resize: 'none',
            border: 'none',
            outline: 'none',
            padding: '10px 60px 10px 14px',
            fontSize: 14,
            lineHeight: 1.5,
            color: '#111827',
            background: 'transparent',
            boxSizing: 'border-box',
            maxHeight: 120,
            overflow: 'auto',
            fontFamily: 'inherit',
            display: 'block',
          }}
        />

        {/* Thread indicator dot: visible when collapsed with existing messages */}
        {!isExpanded && hasMessages && !isLoading && (
          <div style={{
            position: 'absolute',
            right: 46,
            bottom: 16,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#3b82f6',
            pointerEvents: 'none',
          }} />
        )}

        {/* Stop button (while loading) */}
        {isLoading ? (
          <button
            onClick={handleStop}
            title="Stop"
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              padding: '5px 12px',
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            ■
          </button>
        ) : (
          /* Ask button */
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              padding: '5px 12px',
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: input.trim() ? 'pointer' : 'default',
              opacity: input.trim() ? 1 : 0.5,
              lineHeight: 1,
              transition: 'opacity 0.15s',
            }}
          >
            Ask
          </button>
        )}
      </div>
    </div>
  )

  return createPortal(widget, document.body)
}
