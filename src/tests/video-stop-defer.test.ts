/**
 * Verifies the return-then-finalize behavior of the VIDEO_STOP IPC handler.
 *
 * The handler should:
 *   1. Return to the renderer in ~ms (not seconds)
 *   2. Run finalizeVideoFile in the background
 *   3. On success: write recordingPath, broadcast VIDEO_FINALIZED
 *   4. On failure: NOT write recordingPath, broadcast VIDEO_FINALIZE_ERROR
 *   5. Track the in-flight promise in pendingFinalizations and clear it after
 *
 * Mock boundaries:
 *   - electron (ipcMain, BrowserWindow, desktopCapturer, session) → stubs
 *   - video-writer.finalizeVideoFile → vi.fn() controlled by the test
 *   - meeting.repo → vi.fn() to capture writes
 *   - file-manager.buildRecordingFilename → vi.fn() returning a predictable name
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/constants/channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const broadcasts: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
      },
    }],
  },
  desktopCapturer: { getSources: vi.fn() },
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
}))

const mockFinalizeVideoFile = vi.fn()
const mockStartVideoFile = vi.fn()
const mockAppendVideoChunk = vi.fn()
const mockGetPlayableRecordingFilename = vi.fn()
const mockResolveMeetingRecordingFilename = vi.fn()

vi.mock('../main/video/video-writer', () => ({
  startVideoFile: (...args: unknown[]) => mockStartVideoFile(...args),
  appendVideoChunk: (...args: unknown[]) => mockAppendVideoChunk(...args),
  finalizeVideoFile: (...args: unknown[]) => mockFinalizeVideoFile(...args),
  getPlayableRecordingFilename: (...args: unknown[]) => mockGetPlayableRecordingFilename(...args),
  resolveMeetingRecordingFilename: (...args: unknown[]) => mockResolveMeetingRecordingFilename(...args),
}))

const mockGetMeeting = vi.fn()
const mockUpdateMeeting = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
}))

vi.mock('../main/storage/file-manager', () => ({
  buildRecordingFilename: () => 'recording-test.mp4',
}))

const { registerVideoHandlers } = await import('../main/ipc/video.ipc')
const { hasPending, getPending, _resetForTests } = await import('../main/ipc/_finalizations')

beforeEach(() => {
  handlers.clear()
  broadcasts.length = 0
  mockFinalizeVideoFile.mockReset()
  mockGetMeeting.mockReset()
  mockUpdateMeeting.mockReset()
  _resetForTests()
  mockGetMeeting.mockReturnValue({
    id: 'mtg-1',
    title: 'Test',
    date: '2026-05-15T12:00:00Z',
    attendees: ['Sandy'],
    recordingPath: null,
  })
  registerVideoHandlers()
})

afterEach(() => {
  vi.useRealTimers()
})

function getStopHandler(): Handler {
  const h = handlers.get(IPC_CHANNELS.VIDEO_STOP)
  if (!h) throw new Error('VIDEO_STOP handler not registered')
  return h
}

describe('VIDEO_STOP — return then finalize', () => {
  it('returns within 50ms even when finalize takes seconds', async () => {
    // finalizeVideoFile resolves after a long delay
    let resolveFinalize: () => void = () => {}
    mockFinalizeVideoFile.mockImplementation(
      () => new Promise<void>((res) => { resolveFinalize = res })
    )

    const start = performance.now()
    const result = await (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'mtg-1')
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
    expect(result).toEqual({ success: true, filename: 'recording-test.mp4' })
    // Finalize is still in flight at this point.
    expect(mockUpdateMeeting).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(hasPending('video', 'mtg-1')).toBe(true)

    // Now let it resolve and let the microtask queue flush.
    resolveFinalize()
    await getPending('video', 'mtg-1')

    expect(mockUpdateMeeting).toHaveBeenCalledWith('mtg-1', { recordingPath: 'recording-test.mp4' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual({
      channel: IPC_CHANNELS.VIDEO_FINALIZED,
      payload: { meetingId: 'mtg-1', filename: 'recording-test.mp4' },
    })
    expect(hasPending('video', 'mtg-1')).toBe(false)
  })

  it('on finalize success: updateMeeting called, VIDEO_FINALIZED broadcast', async () => {
    mockFinalizeVideoFile.mockResolvedValue(undefined)
    await (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'mtg-1')
    await getPending('video', 'mtg-1')

    expect(mockUpdateMeeting).toHaveBeenCalledTimes(1)
    expect(mockUpdateMeeting).toHaveBeenCalledWith('mtg-1', { recordingPath: 'recording-test.mp4' })
    const successEvents = broadcasts.filter((b) => b.channel === IPC_CHANNELS.VIDEO_FINALIZED)
    expect(successEvents).toHaveLength(1)
    const errorEvents = broadcasts.filter((b) => b.channel === IPC_CHANNELS.VIDEO_FINALIZE_ERROR)
    expect(errorEvents).toHaveLength(0)
  })

  it('on finalize failure: NO updateMeeting, VIDEO_FINALIZE_ERROR broadcast', async () => {
    mockFinalizeVideoFile.mockRejectedValue(new Error('ffmpeg exploded'))
    await (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'mtg-1')
    await getPending('video', 'mtg-1')

    expect(mockUpdateMeeting).not.toHaveBeenCalled()
    const errorEvents = broadcasts.filter((b) => b.channel === IPC_CHANNELS.VIDEO_FINALIZE_ERROR)
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].payload).toEqual({ meetingId: 'mtg-1', error: 'ffmpeg exploded' })
    const successEvents = broadcasts.filter((b) => b.channel === IPC_CHANNELS.VIDEO_FINALIZED)
    expect(successEvents).toHaveLength(0)
  })

  it('always clears pendingFinalizations after either outcome', async () => {
    // Deferred rejection so the map entry is observable before the .finally
    // microtask runs.
    let rejectFinalize: (err: Error) => void = () => {}
    mockFinalizeVideoFile.mockImplementation(
      () => new Promise<void>((_, rej) => { rejectFinalize = rej })
    )
    await (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'mtg-1')
    expect(hasPending('video', 'mtg-1')).toBe(true)
    rejectFinalize(new Error('x'))
    await getPending('video', 'mtg-1')
    expect(hasPending('video', 'mtg-1')).toBe(false)
  })

  it('throws synchronously if meeting is not found', async () => {
    mockGetMeeting.mockReturnValue(null)
    await expect(
      (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'missing')
    ).rejects.toThrow('Meeting not found')
    expect(mockFinalizeVideoFile).not.toHaveBeenCalled()
  })

  it('passes previousRecordingPath (resume case) to finalizeVideoFile', async () => {
    mockGetMeeting.mockReturnValue({
      id: 'mtg-1', title: 't', date: '2026-05-15', attendees: [],
      recordingPath: 'previous-segment.mp4',
    })
    mockFinalizeVideoFile.mockResolvedValue(undefined)
    await (getStopHandler() as (...args: unknown[]) => Promise<unknown>)(null, 'mtg-1')
    await getPending('video', 'mtg-1')
    expect(mockFinalizeVideoFile).toHaveBeenCalledWith('mtg-1', 'recording-test.mp4', 'previous-segment.mp4')
  })
})
