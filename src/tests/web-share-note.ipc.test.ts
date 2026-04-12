/**
 * Tests for the WEB_SHARE_CREATE_NOTE IPC handler in web-share.ipc.ts.
 *
 * Mock boundaries:
 *   - electron ipcMain → captured via ipcMain.handle mock
 *   - notesRepo.getNote → controlled note responses
 *   - global fetch → controlled API responses
 *   - web-share.config → fixed URL/secret
 *
 * Coverage:
 *   success:        note exists, content non-empty → POST to /api/note-share → returns url
 *   not found:      note missing → returns upload_failed error, no fetch
 *   empty content:  note.content is blank → returns upload_failed error, no fetch
 *   server error:   fetch returns non-ok → returns upload_failed error
 *   network error:  fetch throws → returns network_error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))

const getNoteMock = vi.fn()
vi.mock('../main/database/repositories/notes.repo', () => ({
  getNote: getNoteMock,
}))

// meeting.repo is imported by the same file — stub it to avoid DB access
vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: vi.fn(),
}))

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(),
}))

vi.mock('../main/storage/file-manager', () => ({
  readTranscript: vi.fn(),
  readSummary: vi.fn(),
}))

vi.mock('../main/config/web-share.config', () => ({
  WEB_SHARE_API_URL: 'https://cyggie.vercel.app',
  WEB_SHARE_API_SECRET: 'test-secret',
}))

// --- Import after mocks ---

const { registerWebShareHandlers } = await import('../main/ipc/web-share.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// Register handlers so handleMock captures the calls
registerWebShareHandlers()

// Capture the handler immediately after registration, before any clearAllMocks() runs
type HandlerFn = (_event: unknown, noteId: string) => Promise<unknown>
let capturedNoteShareHandler: HandlerFn | null = null
for (const call of handleMock.mock.calls) {
  if (call[0] === IPC_CHANNELS.WEB_SHARE_CREATE_NOTE) {
    capturedNoteShareHandler = call[1] as HandlerFn
    break
  }
}

const BASE_NOTE = {
  id: 'note-1',
  title: 'Q1 Review',
  content: '## Summary\n\nStrong quarter.',
  sourceMeetingId: null,
}

// --- Tests ---

describe('WEB_SHARE_CREATE_NOTE IPC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-register handlers by resetting and re-importing is complex;
    // instead rely on the fact that handleMock captured calls at import time.
  })

  it('registers the WEB_SHARE_CREATE_NOTE handler', () => {
    expect(capturedNoteShareHandler).not.toBeNull()
  })

  it('returns upload_failed when note is not found', async () => {
    getNoteMock.mockReturnValue(null)
    const handler = capturedNoteShareHandler!
    const result = await handler(null, 'missing-id') as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('upload_failed')
  })

  it('returns upload_failed when note content is empty', async () => {
    getNoteMock.mockReturnValue({ ...BASE_NOTE, content: '   ' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handler = capturedNoteShareHandler!
    const result = await handler(null, 'note-1') as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('upload_failed')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns success with url when fetch succeeds', async () => {
    getNoteMock.mockReturnValue(BASE_NOTE)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, token: 'abc123', url: 'https://cyggie.vercel.app/n/abc123' }),
    } as Response)

    const handler = capturedNoteShareHandler!
    const result = await handler(null, 'note-1') as { success: boolean; url: string; token: string }
    expect(result.success).toBe(true)
    expect(result.url).toBe('https://cyggie.vercel.app/n/abc123')
    expect(result.token).toBe('abc123')
  })

  it('sends correct payload to /api/note-share', async () => {
    getNoteMock.mockReturnValue(BASE_NOTE)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, token: 'tok1', url: 'https://cyggie.vercel.app/n/tok1' }),
    } as Response)

    const handler = capturedNoteShareHandler!
    await handler(null, 'note-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://cyggie.vercel.app/api/note-share',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
        body: JSON.stringify({ title: 'Q1 Review', contentMarkdown: BASE_NOTE.content }),
      })
    )
    fetchSpy.mockRestore()
  })

  it('uses "Untitled" when note.title is empty', async () => {
    getNoteMock.mockReturnValue({ ...BASE_NOTE, title: '' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, token: 'tok2', url: 'https://cyggie.vercel.app/n/tok2' }),
    } as Response)

    const handler = capturedNoteShareHandler!
    await handler(null, 'note-1')

    const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(callBody.title).toBe('Untitled')
    fetchSpy.mockRestore()
  })

  it('returns upload_failed when server responds non-ok', async () => {
    getNoteMock.mockReturnValue(BASE_NOTE)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      text: async () => 'Internal Server Error',
    } as Response)

    const handler = capturedNoteShareHandler!
    const result = await handler(null, 'note-1') as { success: boolean; error: string; message: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('upload_failed')
    expect(result.message).toContain('Internal Server Error')
  })

  it('returns network_error when fetch throws', async () => {
    getNoteMock.mockReturnValue(BASE_NOTE)
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'))

    const handler = capturedNoteShareHandler!
    const result = await handler(null, 'note-1') as { success: boolean; error: string; message: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('network_error')
    expect(result.message).toContain('Connection refused')
  })
})
