// @vitest-environment jsdom
/**
 * Verifies that AudioCaptureProvider registers its 4 IPC listeners exactly
 * once for its lifetime, regardless of how many times the recording state
 * toggles. The original implementation re-subscribed on every render because
 * its dep array included hook-return objects that change identity each render.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { IPC_CHANNELS } from '../shared/constants/channels'

type Unsub = () => void
type Handler = (...args: unknown[]) => void

// Capture every api.on call so the test can count registrations and replay
// events directly into the handlers.
const onCalls: Array<{ channel: string; handler: Handler; unsub: Unsub }> = []
const invokeMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../renderer/api', () => ({
  api: {
    on: (channel: string, handler: Handler): Unsub => {
      const unsub = vi.fn()
      onCalls.push({ channel, handler, unsub })
      return unsub
    },
    invoke: (...args: unknown[]) => invokeMock(...args),
    send: vi.fn(),
    once: vi.fn(),
    getPathForFile: () => null,
  },
}))

// The hooks return fresh object literals each render (see useAudioCapture.ts
// line 476). That's the trigger for the original bug — re-rendering the
// Provider produced a new `audioCapture` identity, invalidating the listener
// effect's dep array. The mock preserves that behavior so the test exercises
// the same condition.
const audioStop = vi.fn()
const audioStart = vi.fn().mockResolvedValue(undefined)
const videoStop = vi.fn().mockResolvedValue(undefined)
let videoIsRecording = false

vi.mock('../renderer/hooks/useAudioCapture', () => ({
  useAudioCapture: () => ({ start: audioStart, stop: audioStop, pause: vi.fn(), resume: vi.fn() }),
}))

vi.mock('../renderer/hooks/useVideoCapture', () => ({
  useVideoCapture: () => ({ isVideoRecording: videoIsRecording, stop: videoStop, start: vi.fn() }),
}))

const { AudioCaptureProvider } = await import('../renderer/contexts/AudioCaptureContext')
const { useRecordingStore } = await import('../renderer/stores/recording.store')

function getHandler(channel: string): Handler {
  const entry = onCalls.find((c) => c.channel === channel)
  if (!entry) throw new Error(`no handler registered for ${channel}`)
  return entry.handler
}

function countRegistrations(channel: string): number {
  return onCalls.filter((c) => c.channel === channel).length
}

beforeEach(() => {
  onCalls.length = 0
  invokeMock.mockClear()
  audioStop.mockClear()
  audioStart.mockClear()
  videoStop.mockClear()
  videoIsRecording = false
  useRecordingStore.setState({
    isRecording: false,
    isPaused: false,
    meetingId: null,
    meetingPlatform: null,
    startTime: null,
    duration: 0,
    liveTranscript: [],
    interimSegment: null,
    speakerCount: 0,
    channelMode: null,
    error: null,
    autoStoppedMeetingIds: new Set<string>(),
  })
})

afterEach(() => cleanup())

describe('AudioCaptureProvider — register-once listener pattern', () => {
  it('registers each IPC listener exactly once on mount', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    expect(countRegistrations(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE)).toBe(1)
    expect(countRegistrations(IPC_CHANNELS.RECORDING_STATUS)).toBe(1)
    expect(countRegistrations(IPC_CHANNELS.RECORDING_ERROR)).toBe(1)
    expect(countRegistrations(IPC_CHANNELS.RECORDING_AUTO_STOP)).toBe(1)
    expect(countRegistrations(IPC_CHANNELS.VIDEO_FINALIZED)).toBe(1)
    expect(countRegistrations(IPC_CHANNELS.VIDEO_FINALIZE_ERROR)).toBe(1)
  })

  it('does NOT re-register listeners when isRecording / isPaused toggle', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const baseline = onCalls.length
    act(() => {
      // Many state transitions; each one re-renders the Provider because it
      // subscribes to isRecording and isPaused.
      for (let i = 0; i < 20; i++) {
        useRecordingStore.getState().startRecording(`m-${i}`)
        useRecordingStore.getState().pauseRecording()
        useRecordingStore.getState().resumeRecording()
        useRecordingStore.getState().stopRecording()
      }
    })
    expect(onCalls.length).toBe(baseline)
  })

  it('TRANSCRIPT_UPDATE handler dispatches final and interim segments to the store', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE)
    act(() => {
      handler({ id: 's1', text: 'hello', isFinal: false, startMs: 0, endMs: 100 })
    })
    expect(useRecordingStore.getState().interimSegment?.text).toBe('hello')
    expect(useRecordingStore.getState().liveTranscript).toHaveLength(0)
    act(() => {
      handler({ id: 's1', text: 'hello world', isFinal: true, startMs: 0, endMs: 200 })
    })
    expect(useRecordingStore.getState().interimSegment).toBeNull()
    expect(useRecordingStore.getState().liveTranscript).toHaveLength(1)
    expect(useRecordingStore.getState().liveTranscript[0].text).toBe('hello world')
  })

  it('STATUS handler updates duration / speakerCount / channelMode', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.RECORDING_STATUS)
    act(() => {
      handler({ durationSeconds: 42, speakerCount: 3, isPaused: false, channelMode: 'multichannel' })
    })
    expect(useRecordingStore.getState().duration).toBe(42)
    expect(useRecordingStore.getState().speakerCount).toBe(3)
    expect(useRecordingStore.getState().channelMode).toBe('multichannel')
  })

  it('STATUS handler skips duration update when paused', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    useRecordingStore.setState({ duration: 10 })
    const handler = getHandler(IPC_CHANNELS.RECORDING_STATUS)
    act(() => {
      handler({ durationSeconds: 99, speakerCount: 1, isPaused: true })
    })
    expect(useRecordingStore.getState().duration).toBe(10)
  })

  it('ERROR handler writes to store', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.RECORDING_ERROR)
    act(() => { handler('mic permission denied') })
    expect(useRecordingStore.getState().error).toBe('mic permission denied')
  })

  it('VIDEO_FINALIZED handler bumps lastVideoFinalizedAt with the meetingId', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.VIDEO_FINALIZED)
    expect(useRecordingStore.getState().lastVideoFinalizedAt).toBeNull()
    act(() => { handler({ meetingId: 'mtg-9', filename: 'foo.mp4' }) })
    expect(useRecordingStore.getState().lastVideoFinalizedMeetingId).toBe('mtg-9')
    expect(typeof useRecordingStore.getState().lastVideoFinalizedAt).toBe('number')
  })

  it('VIDEO_FINALIZE_ERROR handler surfaces the error via store.error', () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.VIDEO_FINALIZE_ERROR)
    act(() => { handler({ meetingId: 'mtg-9', error: 'ffmpeg crashed' }) })
    expect(useRecordingStore.getState().error).toContain('ffmpeg crashed')
  })

  it('AUTO_STOP handler reads CURRENT videoCapture ref, not a stale closure', async () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.RECORDING_AUTO_STOP)

    // Initial mount captured videoIsRecording=false in the ref. Now flip the
    // variable and force a Provider re-render via an isPaused toggle — the
    // ref-sync useEffect should pick up the new value.
    act(() => { useRecordingStore.getState().startRecording('m-auto') })
    videoIsRecording = true
    act(() => { useRecordingStore.getState().pauseRecording() })
    act(() => { useRecordingStore.getState().resumeRecording() })

    await act(async () => { await handler() })

    // If the ref were stale (initial videoIsRecording=false), videoStop would
    // not have been called. The register-once + ref pattern means it IS
    // called because the ref-sync effect kept the ref current.
    expect(videoStop).toHaveBeenCalledTimes(1)
    expect(audioStop).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.RECORDING_STOP)
    expect(useRecordingStore.getState().isRecording).toBe(false)
  })

  it('AUTO_STOP is a no-op when isRecording is false', async () => {
    render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const handler = getHandler(IPC_CHANNELS.RECORDING_AUTO_STOP)
    await act(async () => { await handler() })
    expect(audioStop).not.toHaveBeenCalled()
    expect(videoStop).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('fires all 6 unsubs on unmount', () => {
    // 4 RECORDING_* listeners + 2 VIDEO_FINALIZE* listeners.
    const { unmount } = render(<AudioCaptureProvider>{null}</AudioCaptureProvider>)
    const unsubs = onCalls.map((c) => c.unsub)
    expect(unsubs).toHaveLength(6)
    unmount()
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1)
  })
})
