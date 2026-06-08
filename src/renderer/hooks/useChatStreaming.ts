import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { IPC_CHANNELS, type IpcChannel } from '../../shared/constants/channels'
import { chatChannels, type ChatKind } from '../lib/chat-channels'
import { parseChatError, isAbortError } from '../lib/chat-errors'
import type { ChatAttachmentIPC } from '../lib/chat-attachments'

/**
 * Streaming chat dispatch hook. Owns the CHAT_PROGRESS subscription,
 * isLoading/streamedContent state, error parsing, abort, and the 60-second
 * stall watchdog.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ MOUNT                                                             │
 *   │    api.on(CHAT_PROGRESS, …)  ◀─ subscribe ONCE                    │
 *   │      • null     → reset streamedContent                           │
 *   │      • chunk    → if isStreaming, append + reset watchdog timer   │
 *   │                                                                   │
 *   │ send({kind, question, attachments})                               │
 *   │    ─▶ chatChannels(kind) → {query, abort, buildInvokeArgs}        │
 *   │    ─▶ isStreamingRef = true                                       │
 *   │    ─▶ start watchdog (60s no-progress → abort + "stalled")        │
 *   │    ─▶ await api.invoke(query, ...args)                            │
 *   │       on resolve → onComplete(fullText)                           │
 *   │       on reject  → if abort: onAbortPartial(streamedContentRef)   │
 *   │                    else:    onError(parseChatError(err))           │
 *   │    ─▶ isStreamingRef = false; clear streamedContent + watchdog    │
 *   │                                                                   │
 *   │ abort()                                                           │
 *   │    ─▶ api.invoke(abortChannel) — try/catch, log on reject         │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The CHAT_PROGRESS subscription is mounted ONCE for the lifetime of the
 * consumer (closing the race in legacy ChatInterface where the subscription
 * was inside useEffect([isLoading]) and could miss early chunks).
 */

export interface UseChatStreamingArgs {
  /** Called once with the final assistant text when send() resolves. */
  onComplete?: (fullText: string) => void
  /** Called with the streamed partial when send() rejects due to abort. */
  onAbortPartial?: (partial: string) => void
  /** Called with a parsed user-facing message when send() rejects with non-abort error. */
  onError?: (message: string) => void
  /** Watchdog timeout in ms. Defaults to 60 000. Set to 0 to disable. */
  stallTimeoutMs?: number
}

export interface SendArgs {
  kind: ChatKind
  question: string
  attachments?: ChatAttachmentIPC[]
}

export interface UseChatStreamingReturn {
  isLoading: boolean
  streamedContent: string
  error: string | null
  send: (args: SendArgs) => Promise<void>
  abort: (kind: ChatKind) => Promise<void>
  clearError: () => void
}

const DEFAULT_STALL_TIMEOUT_MS = 60_000

export function useChatStreaming({
  onComplete,
  onAbortPartial,
  onError,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
}: UseChatStreamingArgs = {}): UseChatStreamingReturn {
  const [isLoading, setIsLoading] = useState(false)
  const [streamedContent, setStreamedContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Refs for values referenced from the long-lived CHAT_PROGRESS subscription
  // and from async send() callbacks. Refs avoid stale-closure bugs.
  const isStreamingRef = useRef(false)
  const streamedContentRef = useRef('')
  const lastAbortChannelRef = useRef<IpcChannel | null>(null)
  const watchdogRef = useRef<number | null>(null)

  // Keep the latest onComplete / onAbortPartial / onError so the long-lived
  // send call can use them. Updating callbacks each render via refs keeps the
  // hook surface stable.
  const onCompleteRef = useRef(onComplete)
  const onAbortPartialRef = useRef(onAbortPartial)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onCompleteRef.current = onComplete
    onAbortPartialRef.current = onAbortPartial
    onErrorRef.current = onError
  }, [onComplete, onAbortPartial, onError])

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const fireAbort = useCallback(async (channel: IpcChannel) => {
    try {
      await api.invoke(channel)
    } catch (err) {
      console.warn('[chat-streaming] abort failed', { channel, err: String(err) })
    }
  }, [])

  const startWatchdog = useCallback(() => {
    if (stallTimeoutMs <= 0) return
    clearWatchdog()
    watchdogRef.current = window.setTimeout(() => {
      console.warn('[chat-streaming] watchdog fired — aborting stalled stream')
      const abortChannel = lastAbortChannelRef.current
      if (abortChannel) void fireAbort(abortChannel)
      // Don't clear isStreaming here — the in-flight invoke will reject with
      // an abort error and the existing handler will surface a partial /
      // error message naturally.
      onErrorRef.current?.('AI seems to have stalled. Please try again.')
    }, stallTimeoutMs)
  }, [stallTimeoutMs, fireAbort, clearWatchdog])

  // Subscribe to CHAT_PROGRESS exactly ONCE on mount. Gate accumulation by
  // isStreamingRef so chunks emitted between turns (or before send fires)
  // never bleed into state.
  useEffect(() => {
    const unsub = api.on(IPC_CHANNELS.CHAT_PROGRESS, (chunk: unknown) => {
      if (chunk === null) {
        streamedContentRef.current = ''
        setStreamedContent('')
        return
      }
      if (!isStreamingRef.current) return
      const next = streamedContentRef.current + String(chunk)
      streamedContentRef.current = next
      setStreamedContent(next)
      startWatchdog()
    })
    return () => {
      unsub()
      clearWatchdog()
    }
  }, [startWatchdog, clearWatchdog])

  const send = useCallback(async ({ kind, question, attachments }: SendArgs) => {
    const dispatch = chatChannels(kind)
    lastAbortChannelRef.current = dispatch.abort

    setError(null)
    setStreamedContent('')
    streamedContentRef.current = ''
    isStreamingRef.current = true
    setIsLoading(true)
    startWatchdog()

    console.info('[chat-streaming] turn start', { kind: kind.kind })

    try {
      const response = await api.invoke<string>(
        dispatch.query,
        ...dispatch.buildInvokeArgs({ question, attachments })
      )
      onCompleteRef.current?.(response)
      console.info('[chat-streaming] turn end', { kind: kind.kind, len: response.length })
    } catch (err) {
      const errStr = String(err)
      if (isAbortError(errStr)) {
        const partial = streamedContentRef.current
        if (partial) onAbortPartialRef.current?.(partial)
      } else {
        const msg = parseChatError(errStr)
        setError(msg)
        onErrorRef.current?.(msg)
        console.warn('[chat-streaming] turn error', { kind: kind.kind, err: errStr })
      }
    } finally {
      isStreamingRef.current = false
      streamedContentRef.current = ''
      setStreamedContent('')
      setIsLoading(false)
      clearWatchdog()
    }
  }, [startWatchdog, clearWatchdog])

  const abort = useCallback(async (kind: ChatKind) => {
    const dispatch = chatChannels(kind)
    await fireAbort(dispatch.abort)
  }, [fireAbort])

  const clearError = useCallback(() => setError(null), [])

  return { isLoading, streamedContent, error, send, abort, clearError }
}
