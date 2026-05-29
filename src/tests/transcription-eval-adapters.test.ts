// Unit tests for the two surviving transcription provider adapters.
// HTTP is mocked at the global fetch boundary (AssemblyAI) and at the
// @deepgram/sdk module boundary (Deepgram). The point is to verify the
// segment-shape conversion + metadata-passthrough — not to test the
// providers' actual transcription quality.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'fs/promises'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, readFile: vi.fn() }
})

describe('DeepgramBatchAdapter', () => {
  const mockTranscribeFile = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mockTranscribeFile.mockReset()
    vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-audio'))
    vi.doMock('@deepgram/sdk', () => ({
      createClient: () => ({
        listen: {
          prerecorded: { transcribeFile: mockTranscribeFile },
        },
      }),
    }))
  })

  afterEach(() => {
    vi.doUnmock('@deepgram/sdk')
  })

  it('maps utterances to TranscriptSegment[] with diarization tag', async () => {
    mockTranscribeFile.mockResolvedValue({
      result: {
        metadata: { request_id: 'req-123', duration: 60, channels: 2 },
        results: {
          channels: [],
          utterances: [
            {
              speaker: 0,
              transcript: 'Hello world',
              start: 0,
              end: 1.5,
              confidence: 0.9,
              channel: 0,
              words: [],
            },
          ],
        },
      },
      error: null,
    })

    const { DeepgramBatchAdapter } = await import(
      '@main/transcription-eval/adapters/deepgram-batch.adapter'
    )
    const adapter = new DeepgramBatchAdapter('fake-key')
    const result = await adapter.transcribe('/fake/audio.m4a', { keyterms: ['Acme'] })

    expect(result.segments).toEqual([
      { speaker: 0, text: 'Hello world', startTime: 0, endTime: 1.5, isFinal: true },
    ])
    expect(result.text).toBe('Hello world')
    expect(result.requestId).toBe('req-123')
    expect(result.audioDurationSeconds).toBe(60)
    // Post-mono-fix, the batch adapter always uses single-channel
    // diarization (multichannel=false) to match the live streaming
    // path's mono assumption.
    expect(result.diarization).toBe('diarization')
    expect(result.model).toBe('nova-3')
    expect(result.estimatedCostUsd).toBeGreaterThan(0)
  })

  it('throws when Deepgram returns an error', async () => {
    mockTranscribeFile.mockResolvedValue({
      result: null,
      error: { message: 'Bad audio' },
    })
    const { DeepgramBatchAdapter } = await import(
      '@main/transcription-eval/adapters/deepgram-batch.adapter'
    )
    const adapter = new DeepgramBatchAdapter('fake-key')
    await expect(adapter.transcribe('/fake/audio.m4a', {})).rejects.toThrow(/Bad audio/)
  })

  it('rejects construction with empty API key', async () => {
    const { DeepgramBatchAdapter } = await import(
      '@main/transcription-eval/adapters/deepgram-batch.adapter'
    )
    expect(() => new DeepgramBatchAdapter('')).toThrow(/required/)
  })
})

// VoxtralAdapter test block removed 2026-05-28 with the Voxtral adapter
// itself — context-limit and degenerate-loop failures disqualified it.

describe('AssemblyAiAdapter', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-audio'))
  })

  it('runs upload → submit → poll, maps utterances with letter→int speaker conversion', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v2/upload')) {
        return { ok: true, json: async () => ({ upload_url: 'https://cdn.x/audio' }) }
      }
      if (url.endsWith('/v2/transcript')) {
        return { ok: true, json: async () => ({ id: 'tx-789', status: 'queued' }) }
      }
      // poll
      return {
        ok: true,
        json: async () => ({
          id: 'tx-789',
          status: 'completed',
          text: 'Alpha bravo',
          audio_duration: 42,
          utterances: [
            { speaker: 'A', text: 'Alpha', start: 0, end: 1000 },
            { speaker: 'B', text: 'bravo', start: 1000, end: 2000 },
          ],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { AssemblyAiAdapter } = await import(
      '@main/transcription-eval/adapters/assemblyai.adapter'
    )
    const adapter = new AssemblyAiAdapter('fake-key')
    // Shorten the poll wait so the test doesn't sit for 3 seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 })
    const promise = adapter.transcribe('/fake/audio.m4a', { keyterms: ['Acme'] })
    await vi.runAllTimersAsync()
    const result = await promise
    vi.useRealTimers()

    expect(result.segments).toEqual([
      { speaker: 0, text: 'Alpha', startTime: 0, endTime: 1, isFinal: true },
      { speaker: 1, text: 'bravo', startTime: 1, endTime: 2, isFinal: true },
    ])
    expect(result.requestId).toBe('tx-789')
    expect(result.audioDurationSeconds).toBe(42)
    expect(result.diarization).toBe('diarization')
    expect(calls[0]).toMatch(/\/v2\/upload$/)
    expect(calls[1]).toMatch(/\/v2\/transcript$/)
    expect(calls.slice(2).every((c) => c.includes('/v2/transcript/tx-789'))).toBe(true)
    vi.unstubAllGlobals()
  })

  it('throws when the job ends in status=error', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/upload')) {
        return { ok: true, json: async () => ({ upload_url: 'https://cdn.x/a' }) }
      }
      if (url.endsWith('/v2/transcript')) {
        return { ok: true, json: async () => ({ id: 'tx-err', status: 'queued' }) }
      }
      return {
        ok: true,
        json: async () => ({ id: 'tx-err', status: 'error', error: 'transcoding failed' }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { AssemblyAiAdapter } = await import(
      '@main/transcription-eval/adapters/assemblyai.adapter'
    )
    const adapter = new AssemblyAiAdapter('fake-key')
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 })
    // Attach the rejection handler immediately so the timer advance doesn't
    // surface an "unhandled rejection" warning before the assertion runs.
    const expectation = expect(adapter.transcribe('/fake/audio.m4a', {})).rejects.toThrow(
      /transcoding failed/,
    )
    await vi.runAllTimersAsync()
    await expectation
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
