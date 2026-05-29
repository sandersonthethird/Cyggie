// Factory tests cover the four-quadrant decision tree:
//   chosen ok                → return chosen
//   chosen ok, no fallback   → return chosen (regression guard)
//   chosen fail, other ok    → return other + fallback metadata
//   chosen fail, other fail  → throw original error
// Plus key-not-configured branches.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

class FakeWs extends EventEmitter {
  readyState = 0
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWs[] = []
  /**
   * Map of url-substring → 'success' | 'fail-immediately' | 'fail-after-delay-ms'.
   * Tests set this before constructing the factory client.
   */
  static behavior: Map<string, 'success' | 'fail' | number> = new Map()
  url: string
  sentMessages: (Buffer | string)[] = []

  constructor(url: string) {
    super()
    this.url = url
    FakeWs.instances.push(this)
    const matchKey = [...FakeWs.behavior.keys()].find((k) => url.includes(k))
    const action = matchKey ? FakeWs.behavior.get(matchKey) : 'success'
    setImmediate(() => {
      if (action === 'fail') {
        this.emit('error', new Error('fake connect failure'))
        this.emit('close', 1006, Buffer.from(''))
      } else if (typeof action === 'number') {
        setTimeout(() => {
          this.emit('error', new Error('fake delayed failure'))
          this.emit('close', 1006, Buffer.from(''))
        }, action)
      } else {
        this.readyState = FakeWs.OPEN
        this.emit('open')
        // AssemblyAI needs a Begin message to resolve connect; emit it.
        if (url.includes('assemblyai')) {
          setImmediate(() =>
            this.emit('message', Buffer.from(JSON.stringify({ type: 'Begin' }))),
          )
        }
      }
    })
  }

  send(data: Buffer | string): void {
    this.sentMessages.push(data)
  }

  ping(): void {}

  close(): void {
    this.readyState = FakeWs.CLOSED
  }
}

vi.mock('ws', () => ({ default: FakeWs }))

vi.mock('@deepgram/sdk', () => {
  // Fake Deepgram SDK that mirrors the relevant surface — the live
  // connection emitter with Open/Transcript/Error/Close events. The
  // factory only awaits the open event when connect() resolves.
  const deepgramEvents = {
    Open: 'open',
    Transcript: 'transcript',
    UtteranceEnd: 'utterance-end',
    Error: 'error',
    Close: 'close',
  }
  return {
    LiveTranscriptionEvents: deepgramEvents,
    createClient: (apiKey: string) => ({
      listen: {
        live: () => {
          const conn = new EventEmitter() as EventEmitter & {
            getReadyState: () => number
            send: (buf: Buffer) => void
            keepAlive: () => void
            finalize: () => void
            requestClose: () => void
          }
          conn.getReadyState = () => 1
          conn.send = () => {}
          conn.keepAlive = () => {}
          conn.finalize = () => {}
          conn.requestClose = () => {}
          setImmediate(() => {
            if (apiKey === 'fail-deepgram') {
              conn.emit('error', { message: 'deepgram unreachable' })
            } else {
              conn.emit('open')
            }
          })
          return conn
        },
      },
    }),
  }
})

async function importFactory() {
  return await import('../main/transcription/factory')
}

beforeEach(() => {
  FakeWs.instances = []
  FakeWs.behavior = new Map()
})

describe('createStreamingTranscriber', () => {
  it('returns the chosen client when chosen provider connects', async () => {
    const { createStreamingTranscriber } = await importFactory()
    const result = await createStreamingTranscriber({
      chosenProvider: 'deepgram',
      resolveApiKey: (p) => (p === 'deepgram' ? 'dg-key' : 'aa-key'),
    })
    expect(result.client.provider).toBe('deepgram')
    expect(result.fallback).toBeUndefined()
    await result.client.close()
  })

  it('returns the AssemblyAI client when chosen=assemblyai and it connects', async () => {
    const { createStreamingTranscriber } = await importFactory()
    const result = await createStreamingTranscriber({
      chosenProvider: 'assemblyai',
      resolveApiKey: (p) => (p === 'assemblyai' ? 'aa-key' : 'dg-key'),
    })
    expect(result.client.provider).toBe('assemblyai')
    expect(result.fallback).toBeUndefined()
    await result.client.close()
  })

  it('falls back to AssemblyAI when Deepgram connect fails AND aa key is configured', async () => {
    const { createStreamingTranscriber } = await importFactory()
    const result = await createStreamingTranscriber({
      chosenProvider: 'deepgram',
      resolveApiKey: (p) => (p === 'deepgram' ? 'fail-deepgram' : 'aa-key'),
    })
    expect(result.client.provider).toBe('assemblyai')
    expect(result.fallback).toBeDefined()
    expect(result.fallback?.originalProvider).toBe('deepgram')
    await result.client.close()
  })

  it('falls back to Deepgram when AssemblyAI connect fails AND dg key is configured', async () => {
    FakeWs.behavior.set('streaming.assemblyai.com', 'fail')
    const { createStreamingTranscriber } = await importFactory()
    const result = await createStreamingTranscriber({
      chosenProvider: 'assemblyai',
      resolveApiKey: (p) => (p === 'assemblyai' ? 'aa-key' : 'dg-key'),
    })
    expect(result.client.provider).toBe('deepgram')
    expect(result.fallback).toBeDefined()
    expect(result.fallback?.originalProvider).toBe('assemblyai')
    await result.client.close()
  })

  it('throws when chosen has no key AND fallback also has no key', async () => {
    const { createStreamingTranscriber } = await importFactory()
    await expect(
      createStreamingTranscriber({
        chosenProvider: 'deepgram',
        resolveApiKey: () => null,
      }),
    ).rejects.toThrow(/No API key configured for deepgram/)
  })

  it('uses the other provider when chosen has no key but other does', async () => {
    const { createStreamingTranscriber } = await importFactory()
    const result = await createStreamingTranscriber({
      chosenProvider: 'assemblyai',
      resolveApiKey: (p) => (p === 'deepgram' ? 'dg-key' : null),
    })
    expect(result.client.provider).toBe('deepgram')
    expect(result.fallback?.originalProvider).toBe('assemblyai')
    await result.client.close()
  })

  it('throws when both providers fail to connect', async () => {
    FakeWs.behavior.set('streaming.assemblyai.com', 'fail')
    const { createStreamingTranscriber } = await importFactory()
    await expect(
      createStreamingTranscriber({
        chosenProvider: 'assemblyai',
        resolveApiKey: (p) => (p === 'deepgram' ? 'fail-deepgram' : 'aa-key'),
      }),
    ).rejects.toThrow()
  })
})
