'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatPanelProps {
  token: string
  meetingTitle: string
  apiPath?: string
  showHeader?: boolean
}

export default function ChatPanel({ token, meetingTitle, apiPath = '/api/chat', showHeader = true }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamedContent])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
    }
  }, [input])

  const handleSubmit = useCallback(async () => {
    const question = input.trim()
    if (!question || isLoading) return

    setInput('')
    setError(null)
    setIsLoading(true)
    setStreamedContent('')

    const userMessage: Message = { role: 'user', content: question }
    setMessages((prev) => [...prev, userMessage])

    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          question,
          history: messages.slice(-10), // Last 10 messages for context
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error || 'Chat request failed')
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') break
            try {
              const parsed = JSON.parse(data)
              if (parsed.error) throw new Error(parsed.error)
              accumulated += parsed.text
              setStreamedContent(accumulated)
            } catch (e) {
              if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                throw e
              }
            }
          }
        }
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: accumulated }])
      setStreamedContent('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }, [input, isLoading, token, messages, apiPath])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-900">
      {showHeader && (
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Ask about this meeting
          </h2>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && !isLoading && (
          <div className="text-center text-sm text-gray-400 dark:text-gray-500 py-8">
            Ask a question about &ldquo;{meetingTitle}&rdquo;
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700'
              }`}
            >
              {msg.role === 'user' ? (
                <div className="whitespace-pre-wrap">{msg.content}</div>
              ) : (
                <div className="summary-markdown"><ReactMarkdown>{msg.content}</ReactMarkdown></div>
              )}
            </div>
          </div>
        ))}

        {isLoading && streamedContent && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700">
              <div className="summary-markdown"><ReactMarkdown>{streamedContent}</ReactMarkdown></div>
            </div>
          </div>
        )}

        {isLoading && !streamedContent && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 text-sm text-gray-400 dark:text-gray-500 italic">
              Thinking...
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg px-3 py-2 text-sm bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-gray-200 dark:border-gray-800">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:focus:border-blue-400 placeholder-gray-400"
            placeholder="Ask a question..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            rows={1}
          />
          <button
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-default transition-colors flex-shrink-0"
            onClick={handleSubmit}
            disabled={isLoading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
