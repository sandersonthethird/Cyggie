// Unit tests for AssemblyAiStreamingClient with a mocked WebSocket.
//
// We replace the 'ws' module with a controllable EventEmitter so each test
// can drive the message stream without an actual server. The test verifies
// the contract the client promises to RecordingSession: emit 'connected'
// on Begin, emit 'transcript' on Turn (with correct shape), emit 'error'
// with the right code on protocol/transport failures, etc.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

class FakeWs extends EventEmitter {
  readyState = 0 // CONNECTING by default
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  static instances: FakeWs[] = []
  url: string
  headers: Record<string, string>
  sentMessages: (Buffer | string)[] = []
  closeCode: number | null = null

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super()
    this.url = url
    this.headers = options?.headers ?? {}
    FakeWs.instances.push(this)
  }

  send(data: Buffer | string): void {
    this.sentMessages.push(data)
  }

  ping(): void {
    // no-op for tests
  }

  close(code?: number): void {
    this.closeCode = code ?? 1000
    this.readyState = FakeWs.CLOSED
    // Emit close on next tick like real ws would.
    setImmediate(() => this.emit('close', this.closeCode, Buffer.from('')))
  }

  /** Test helper: simulate the open handshake completing. */
  fakeOpen(): void {
    this.readyState = FakeWs.OPEN
    this.emit('open')
  }

  /** Test helper: deliver a message from the "server." */
  fakeMessage(payload: unknown): void {
    const data =
      typeof payload === 'string'
        ? Buffer.from(payload)
        : Buffer.from(JSON.stringify(payload))
    this.emit('message', data)
  }

  /** Test helper: simulate the server closing the connection. */
  fakeServerClose(code = 1000): void {
    this.readyState = FakeWs.CLOSED
    this.emit('close', code, Buffer.from(''))
  }

  /** Test helper: emit a transport error. */
  fakeError(err: Error): void {
    this.emit('error', err)
  }
}

vi.mock('ws', () => ({
  default: FakeWs,
}))

// Helpers ────────────────────────────────────────────────────────────────────

async function importClient() {
  const mod = await import('../main/transcription/assemblyai-streaming-client')
  return mod.AssemblyAiStreamingClient
}

function lastWs(): FakeWs {
  const ws = FakeWs.instances[FakeWs.instances.length - 1]
  if (!ws) throw new Error('No FakeWs instance constructed')
  return ws
}

// Tests ──────────────────────────────────────────────────────────────────────

describe('AssemblyAiStreamingClient', () => {
  beforeEach(() => {
    FakeWs.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the WebSocket with the expected query params and Authorization header', async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'test-key' })

    const connectPromise = c.connect()
    const ws = lastWs()

    expect(ws.url).toContain('wss://streaming.assemblyai.com/v3/ws')
    expect(ws.url).toContain('sample_rate=16000')
    expect(ws.url).toContain('encoding=pcm_s16le')
    expect(ws.url).toContain('speaker_labels=true')
    expect(ws.headers['Authorization']).toBe('test-key')

    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin', id: 'sess-1' })
    await connectPromise
  })

  it('forwards keyterms via the keyterms_prompt query param', async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({
      apiKey: 'k',
      keyterms: ['Sandy Cass', 'Franklin Templeton'],
    })

    void c.connect().catch(() => {})
    const ws = lastWs()
    // URLSearchParams form-encodes spaces as '+'. The values still arrive
    // intact at AssemblyAI's parser, which handles both '+' and '%20'.
    expect(ws.url).toContain('keyterms_prompt=Sandy+Cass%2CFranklin+Templeton')
  })

  it("emits 'connected' on the Begin message (not on raw socket open)", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })

    const connectedSpy = vi.fn()
    c.on('connected', connectedSpy)

    const connectPromise = c.connect()
    const ws = lastWs()

    ws.fakeOpen()
    expect(connectedSpy).not.toHaveBeenCalled() // open alone isn't enough

    ws.fakeMessage({ type: 'Begin', id: 'sess-1' })
    await connectPromise
    expect(connectedSpy).toHaveBeenCalledOnce()
  })

  it("emits 'transcript' with isFinal=true on Turn with end_of_turn=true, mapping speaker letters to ints", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const captured: unknown[] = []
    c.on('transcript', (r) => captured.push(r))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage({
      type: 'Turn',
      transcript: 'Hello there',
      end_of_turn: true,
      speaker_label: 'B',
      audio_start: 1000,
      audio_end: 2000,
      words: [
        { text: 'Hello', start: 1000, end: 1500, confidence: 0.95, speaker: 'B' },
        { text: 'there', start: 1500, end: 2000, confidence: 0.95, speaker: 'B' },
      ],
    })

    expect(captured).toHaveLength(1)
    const result = captured[0] as {
      text: string
      isFinal: boolean
      speechFinal: boolean
      words: Array<{ speaker: number; word: string }>
      start: number
      duration: number
      channelIndex: number
    }
    expect(result.text).toBe('Hello there')
    expect(result.isFinal).toBe(true)
    expect(result.speechFinal).toBe(true)
    expect(result.channelIndex).toBe(0)
    expect(result.start).toBe(1.0)
    expect(result.duration).toBeCloseTo(1.0, 1)
    expect(result.words.every((w) => w.speaker === 1)).toBe(true) // 'B' → 1
  })

  it('emits transcripts with isFinal=false for in-progress Turns', async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const captured: Array<{ isFinal: boolean }> = []
    c.on('transcript', (r) => captured.push(r as { isFinal: boolean }))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage({
      type: 'Turn',
      transcript: 'Hello',
      end_of_turn: false,
      speaker_label: 'A',
      words: [{ text: 'Hello', start: 0, end: 500, confidence: 0.9, speaker: 'A' }],
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].isFinal).toBe(false)
  })

  it("maps speaker_label='UNKNOWN' to integer 999", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const captured: Array<{ words: Array<{ speaker: number }> }> = []
    c.on('transcript', (r) => captured.push(r as { words: Array<{ speaker: number }> }))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage({
      type: 'Turn',
      transcript: 'Yeah',
      end_of_turn: true,
      speaker_label: 'UNKNOWN',
      words: [{ text: 'Yeah', start: 0, end: 200, confidence: 0.9, speaker: 'UNKNOWN' }],
    })

    expect(captured[0].words[0].speaker).toBe(999)
  })

  it("emits SERVER_TERMINATED error code on a server-initiated Termination", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const errors: Array<{ code: string }> = []
    c.on('error', (e) => errors.push(e as { code: string }))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage({ type: 'Termination', audio_duration_seconds: 30 })

    expect(errors.some((e) => e.code === 'SERVER_TERMINATED')).toBe(true)
  })

  it("emits MALFORMED_TURN_PAYLOAD on non-JSON server messages", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const errors: Array<{ code: string }> = []
    c.on('error', (e) => errors.push(e as { code: string }))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage('not valid json {')

    expect(errors.some((e) => e.code === 'MALFORMED_TURN_PAYLOAD')).toBe(true)
  })

  it("emits UNKNOWN_MESSAGE_TYPE on unrecognized server message types", async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })
    const errors: Array<{ code: string }> = []
    c.on('error', (e) => errors.push(e as { code: string }))

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    ws.fakeMessage({ type: 'SomethingNew', payload: 'whatever' })

    expect(errors.some((e) => e.code === 'UNKNOWN_MESSAGE_TYPE')).toBe(true)
  })

  it('sendAudio writes raw PCM bytes to the WebSocket when OPEN', async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    const chunk = Buffer.from([0x01, 0x02, 0x03, 0x04])
    c.sendAudio(chunk)
    expect(ws.sentMessages).toContain(chunk)
  })

  it('buffers audio when not connected and flushes on reconnect-open', async () => {
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })

    const chunk1 = Buffer.from([0x01, 0x02])
    const chunk2 = Buffer.from([0x03, 0x04])
    c.sendAudio(chunk1) // before connect — buffered
    c.sendAudio(chunk2)

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    // After open + Begin, both buffered chunks should have been sent.
    expect(ws.sentMessages).toContain(chunk1)
    expect(ws.sentMessages).toContain(chunk2)
  })

  it('finalizeAndClose sends Terminate then closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const AssemblyAiStreamingClient = await importClient()
    const c = new AssemblyAiStreamingClient({ apiKey: 'k' })

    const connectPromise = c.connect()
    const ws = lastWs()
    ws.fakeOpen()
    ws.fakeMessage({ type: 'Begin' })
    await connectPromise

    const closePromise = c.finalizeAndClose({ quietMs: 50, maxWaitMs: 500, closeWaitMs: 50 })
    await vi.runAllTimersAsync()
    await closePromise

    const sentJson = ws.sentMessages.find(
      (m) => typeof m === 'string' && m.includes('"type":"Terminate"'),
    )
    expect(sentJson).toBeDefined()
    expect(ws.closeCode).toBe(1000)
    vi.useRealTimers()
  })

  it('constructor throws if apiKey is empty', async () => {
    const AssemblyAiStreamingClient = await importClient()
    expect(() => new AssemblyAiStreamingClient({ apiKey: '' })).toThrow(/API key/)
  })
})
