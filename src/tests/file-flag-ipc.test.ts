/**
 * Tests for the COMPANY_FILE_FLAG_TOGGLE IPC handler in company-chat.ipc.ts.
 *
 * Phase 3 refactor: the handler now branches on `isFlaggedForCompany` and
 * calls `flagFile` / `unflagFile` (from the sync-wrapped barrel) instead of
 * the deprecated `toggleFileFlag`. After every state change it broadcasts
 * COMPANY_FLAGS_CHANGED to renderer windows and kicks the extraction
 * worker via `notifyPending()`.
 *
 * What this exercises (pre-flight validation + new explicit verbs):
 *
 *   1. Already-flagged files unflag without re-validating; calls unflagFile,
 *      NOT flagFile.
 *   2. Toggle-on with MISSING file        → { ok: false, code: 'MISSING' }
 *   3. Toggle-on with UNSUPPORTED_FORMAT  → { ok: false, code: 'UNSUPPORTED_FORMAT' }
 *   4. Toggle-on with TOO_LARGE           → { ok: false, code: 'TOO_LARGE' }
 *   5. Toggle-on with valid file          → flagFile invoked; notifyPending
 *                                            fires; ok:true returned.
 *
 * Mock boundaries:
 *   - electron ipcMain + BrowserWindow    → captured handle() + empty windows list
 *   - sqlite repositories barrel          → isFlaggedForCompany / flagFile /
 *                                            unflagFile / refreshFlaggedFile
 *   - storage/file-manager                → validateFileForChatContext
 *   - flagged-file-extraction-worker      → notifyPending
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  BrowserWindow: { getAllWindows: () => [] },
}))

const isFlaggedForCompanyMock = vi.fn()
const flagFileMock = vi.fn()
const unflagFileMock = vi.fn()
const refreshFlaggedFileMock = vi.fn()
const getFlaggedFileIdsMock = vi.fn()
const getFlaggedFilesDetailedMock = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  isFlaggedForCompany: isFlaggedForCompanyMock,
  flagFile: flagFileMock,
  unflagFile: unflagFileMock,
  refreshFlaggedFile: refreshFlaggedFileMock,
  getFlaggedFileIds: getFlaggedFileIdsMock,
  getFlaggedFilesDetailed: getFlaggedFilesDetailedMock,
}))

const validateMock = vi.fn()
vi.mock('../main/storage/file-manager', () => ({
  validateFileForChatContext: validateMock,
}))

const notifyPendingMock = vi.fn()
vi.mock('../main/services/flagged-file-extraction-worker', () => ({
  notifyPending: notifyPendingMock,
}))

vi.mock('@cyggie/services/llm/company-chat', () => ({
  abortCompanyChat: vi.fn(),
}))
vi.mock('@cyggie/services/llm/chat-dispatch', () => ({
  chatDispatch: vi.fn(),
}))
vi.mock('@cyggie/services/llm/chat-persistence', () => ({
  withChatPersistence: vi.fn(),
}))
vi.mock('@cyggie/services/llm/send-progress', () => ({
  withProgressSink: vi.fn(),
}))
vi.mock('../main/lib/ipc-progress-sink', () => ({
  createChatProgressSink: vi.fn(),
}))
vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'user-1',
}))
vi.mock('../shared/utils/chat-context', () => ({
  deriveChatContext: () => ({ contextId: 'co-1', kind: 'company' }),
}))
vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => ({
    prepare: () => ({ get: () => ({ canonical_name: 'Acme' }) }),
  }),
}))

const { registerCompanyChatHandlers } = await import('../main/ipc/company-chat.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

registerCompanyChatHandlers()

type ToggleResult =
  | { ok: true; flagged: boolean }
  | { ok: false; code: 'MISSING' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'DRIVE_SCOPE_INSUFFICIENT'; message: string }
type ToggleHandlerFn = (
  _event: unknown,
  data: { companyId: string; fileId: string; fileName: string; mimeType?: string }
) => ToggleResult

let toggleHandler: ToggleHandlerFn | null = null
for (const call of handleMock.mock.calls) {
  if (call[0] === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) {
    toggleHandler = call[1] as ToggleHandlerFn
    break
  }
}

describe('COMPANY_FILE_FLAG_TOGGLE handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isFlaggedForCompanyMock.mockReturnValue(false)
    flagFileMock.mockReturnValue({ id: 'flag-1' })
    unflagFileMock.mockReturnValue(undefined)
    validateMock.mockReturnValue({ ok: true })
  })

  it('registers the handler', () => {
    expect(toggleHandler).not.toBeNull()
  })

  it('throws when companyId or fileId is missing', () => {
    expect(() =>
      toggleHandler!(null, { companyId: '', fileId: '/x', fileName: 'x' })
    ).toThrow('companyId and fileId are required')
    expect(() =>
      toggleHandler!(null, { companyId: 'c', fileId: '', fileName: 'x' })
    ).toThrow('companyId and fileId are required')
  })

  it('unflags an already-flagged file WITHOUT re-validating; does NOT call flagFile', () => {
    isFlaggedForCompanyMock.mockReturnValue(true)

    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/path/missing.pdf',
      fileName: 'missing.pdf',
    })

    expect(validateMock).not.toHaveBeenCalled()
    expect(flagFileMock).not.toHaveBeenCalled()
    expect(unflagFileMock).toHaveBeenCalledWith({
      companyId: 'co-1',
      fileId: '/path/missing.pdf',
    })
    expect(result).toEqual({ ok: true, flagged: false })
    // Unflag is terminal — no extraction work to queue.
    expect(notifyPendingMock).not.toHaveBeenCalled()
  })

  it('returns ok:false code:MISSING when file does not exist', () => {
    validateMock.mockReturnValue({ ok: false, code: 'MISSING', message: 'File not found' })
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/no/such.pdf',
      fileName: 'such.pdf',
    })
    expect(result).toEqual({ ok: false, code: 'MISSING', message: 'File not found' })
    expect(flagFileMock).not.toHaveBeenCalled()
    expect(notifyPendingMock).not.toHaveBeenCalled()
  })

  it('returns ok:false code:UNSUPPORTED_FORMAT for non-readable extensions', () => {
    validateMock.mockReturnValue({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: 'Unsupported file format (.pages).',
    })
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/doc.pages',
      fileName: 'doc.pages',
    })
    expect(result).toEqual({
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      message: 'Unsupported file format (.pages).',
    })
    expect(flagFileMock).not.toHaveBeenCalled()
  })

  it('returns ok:false code:TOO_LARGE for files over the size cap', () => {
    validateMock.mockReturnValue({
      ok: false,
      code: 'TOO_LARGE',
      message: 'File is too large (12.5 MB). Max 10 MB.',
    })
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/big.pdf',
      fileName: 'big.pdf',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TOO_LARGE')
    expect(flagFileMock).not.toHaveBeenCalled()
  })

  it('flags a valid file and kicks the extraction worker', () => {
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/memo.pdf',
      fileName: 'memo.pdf',
    })
    expect(validateMock).toHaveBeenCalledWith('/memo.pdf', undefined)
    expect(flagFileMock).toHaveBeenCalledWith({
      companyId: 'co-1',
      fileId: '/memo.pdf',
      fileName: 'memo.pdf',
      mimeType: null,
      userId: 'user-1',
      flaggedByUserId: 'user-1',
    })
    expect(result).toEqual({ ok: true, flagged: true })
    expect(notifyPendingMock).toHaveBeenCalledTimes(1)
  })

  it('passes mimeType through to validator and flagFile for Google native files', () => {
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '1ABC_doc',
      fileName: 'Q2 partner memo',
      mimeType: 'application/vnd.google-apps.document',
    })
    expect(validateMock).toHaveBeenCalledWith('1ABC_doc', 'application/vnd.google-apps.document')
    expect(flagFileMock).toHaveBeenCalledWith({
      companyId: 'co-1',
      fileId: '1ABC_doc',
      fileName: 'Q2 partner memo',
      mimeType: 'application/vnd.google-apps.document',
      userId: 'user-1',
      flaggedByUserId: 'user-1',
    })
    expect(result).toEqual({ ok: true, flagged: true })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Phase 3 — refresh handler
// ──────────────────────────────────────────────────────────────────────────

type RefreshResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FLAGGED'; message: string }
type RefreshHandlerFn = (
  _event: unknown,
  data: { companyId: string; fileId: string }
) => RefreshResult

let refreshHandler: RefreshHandlerFn | null = null
for (const call of handleMock.mock.calls) {
  if (call[0] === IPC_CHANNELS.COMPANY_FILE_FLAG_REFRESH) {
    refreshHandler = call[1] as RefreshHandlerFn
    break
  }
}

describe('COMPANY_FILE_FLAG_REFRESH handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers the handler', () => {
    expect(refreshHandler).not.toBeNull()
  })

  it('refreshes an existing flag, stamps current user, kicks worker', () => {
    refreshFlaggedFileMock.mockReturnValue({ id: 'flag-1' })

    const result = refreshHandler!(null, { companyId: 'co-1', fileId: '/memo.pdf' })

    expect(refreshFlaggedFileMock).toHaveBeenCalledWith({
      companyId: 'co-1',
      fileId: '/memo.pdf',
      flaggedByUserId: 'user-1',
    })
    expect(result).toEqual({ ok: true })
    expect(notifyPendingMock).toHaveBeenCalledTimes(1)
  })

  it('returns NOT_FLAGGED when the row does not exist', () => {
    refreshFlaggedFileMock.mockReturnValue(null)

    const result = refreshHandler!(null, { companyId: 'co-1', fileId: '/gone.pdf' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FLAGGED')
    expect(notifyPendingMock).not.toHaveBeenCalled()
  })

  it('throws when companyId or fileId missing', () => {
    expect(() => refreshHandler!(null, { companyId: '', fileId: '/x' })).toThrow(
      'companyId and fileId are required',
    )
    expect(() => refreshHandler!(null, { companyId: 'c', fileId: '' })).toThrow(
      'companyId and fileId are required',
    )
  })
})
