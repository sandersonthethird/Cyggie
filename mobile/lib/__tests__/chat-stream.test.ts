import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Module mocks must be hoisted by vi.mock so the module under test sees
// the stubbed deps at import time.
vi.mock('../auth/store', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'test-token' }),
  },
}))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    GATEWAY_URL: 'http://test',
    ensureFreshAccessToken: vi.fn(async () => 'refreshed-token'),
  }
})

vi.mock('../sync/clock', () => ({
  tick: () => '12345',
}))

import {
  sendSessionMessageStream,
  type ChatStreamError,
  type SendSessionMessageResult,
} from '../api/chat'

// Build a Response whose body is a ReadableStream over the given chunks.
// Lets us simulate token-by-token gateway emission.
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
        // Yield to the event loop so the consumer's reader.read() returns
        // each chunk separately (simulates network packet boundaries).
        await new Promise((r) => setTimeout(r, 0))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function collectHandlers(): {
  tokens: string[]
  done: SendSessionMessageResult | null
  errors: ChatStreamError[]
  handlers: Parameters<typeof sendSessionMessageStream>[2]
} {
  const tokens: string[] = []
  let done: SendSessionMessageResult | null = null
  const errors: ChatStreamError[] = []
  return {
    tokens,
    get done() {
      return done
    },
    errors,
    handlers: {
      onToken: (t) => tokens.push(t),
      onDone: (r) => {
        done = r
      },
      onError: (e) => errors.push(e),
    },
  }
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  fetchMock.mockReset()
})

describe('sendSessionMessageStream', () => {
  test('1. happy path: tokens dispatch + onDone fires with final result', async () => {
    const sessionMock = {
      id: 's1',
      contextId: 'c1',
      contextKind: 'crm',
      contextLabel: null,
      title: 'Hi',
      previewText: null,
      messageCount: 2,
      isPinned: false,
      isArchived: false,
      isActive: true,
      lastMessageAt: '2026-05-23T00:00:00Z',
      updatedAt: '2026-05-23T00:00:00Z',
      lamport: '5',
    }
    const userMsg = {
      id: 'u1',
      sessionId: 's1',
      role: 'user' as const,
      content: 'hi',
      citations: null,
      attachmentsJson: null,
      createdAt: '2026-05-23T00:00:00Z',
      lamport: '12345',
    }
    const asstMsg = {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant' as const,
      content: 'Hello world',
      citations: null,
      attachmentsJson: null,
      createdAt: '2026-05-23T00:00:00Z',
      lamport: '12346',
    }
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: token\ndata: {"text":"Hello"}\n\n',
        'event: token\ndata: {"text":" world"}\n\n',
        `event: done\ndata: ${JSON.stringify({ session: sessionMock, userMessage: userMsg, assistantMessage: asstMsg })}\n\n`,
      ]),
    )

    const sink = collectHandlers()
    await sendSessionMessageStream('s1', { content: 'hi' }, sink.handlers)

    expect(sink.tokens).toEqual(['Hello', ' world'])
    expect(sink.errors).toEqual([])
    expect(sink.done?.assistantMessage.content).toBe('Hello world')
  })

  test('2. event:error from gateway → onError({code: "gateway_error"})', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: error\ndata: {"code":"CHAT_PROVIDER_ERROR","message":"upstream 502"}\n\n',
      ]),
    )

    const sink = collectHandlers()
    await sendSessionMessageStream('s1', { content: 'hi' }, sink.handlers)

    expect(sink.done).toBeNull()
    expect(sink.errors).toHaveLength(1)
    const err = sink.errors[0]!
    expect(err.code).toBe('gateway_error')
    if (err.code === 'gateway_error') {
      expect(err.gatewayCode).toBe('CHAT_PROVIDER_ERROR')
      expect(err.message).toBe('upstream 502')
    }
  })

  test('3. fetch throws → onError({code: "network"})', async () => {
    fetchMock.mockRejectedValueOnce(new Error('wifi gone'))

    const sink = collectHandlers()
    await sendSessionMessageStream('s1', { content: 'hi' }, sink.handlers)

    expect(sink.errors).toHaveLength(1)
    const err = sink.errors[0]!
    expect(err.code).toBe('network')
    if (err.code === 'network') expect(err.message).toBe('wifi gone')
    expect(sink.done).toBeNull()
  })

  test('4. non-2xx HTTP status (e.g., 413) → onError({code: "http", status: 413})', async () => {
    const errorBody = { error: { code: 'CHAT_INPUT_TOO_LARGE', message: 'too big' } }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const sink = collectHandlers()
    await sendSessionMessageStream('s1', { content: 'x'.repeat(200_000) }, sink.handlers)

    expect(sink.errors).toHaveLength(1)
    const err = sink.errors[0]!
    expect(err.code).toBe('http')
    if (err.code === 'http') {
      expect(err.status).toBe(413)
      expect(err.body).toMatchObject(errorBody)
    }
  })

  test('5. AbortSignal fires mid-stream → onError(network) and no done', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (_url, opts) => {
      // Simulate the abort behavior: if signal is already aborted at fetch
      // call time, throw AbortError synchronously (matches real fetch).
      if ((opts as { signal?: AbortSignal })?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      // Otherwise return a never-ending stream; abort during reader.read()
      // surfaces via the read promise rejecting.
      return new Response(
        new ReadableStream({
          start(c) {
            const sig = (opts as { signal?: AbortSignal })?.signal
            if (sig) {
              sig.addEventListener('abort', () => {
                c.error(new DOMException('Aborted', 'AbortError'))
              })
            }
            c.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"partial"}\n\n'))
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    })

    const sink = collectHandlers()
    const promise = sendSessionMessageStream('s1', { content: 'hi' }, sink.handlers, controller.signal)
    // Abort after a tick so the first token has a chance to dispatch.
    setTimeout(() => controller.abort(), 5)
    await promise

    // Either onError fired with network (most likely), or zero done events.
    expect(sink.done).toBeNull()
    expect(sink.errors.length).toBeGreaterThanOrEqual(1)
    expect(sink.errors[0]?.code).toBe('network')
  })
})
