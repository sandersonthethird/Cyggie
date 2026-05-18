/**
 * Tests for the COMPANY_FILE_FLAG_TOGGLE IPC handler in company-chat.ipc.ts.
 *
 * What this exercises (Issue 4A — pre-flight validation gating):
 *
 *   1. Already-flagged files unflag without re-validating (toggle off must
 *      always succeed even if file vanished from disk).
 *   2. Toggle-on with MISSING file        → { ok: false, code: 'MISSING' }
 *   3. Toggle-on with UNSUPPORTED_FORMAT  → { ok: false, code: 'UNSUPPORTED_FORMAT' }
 *   4. Toggle-on with TOO_LARGE           → { ok: false, code: 'TOO_LARGE' }
 *   5. Toggle-on with valid file          → toggleFileFlag invoked, ok:true returned
 *
 * Mock boundaries:
 *   - electron ipcMain                    → captured handle()
 *   - company-file-flags.repo             → getFlaggedFileIds + toggleFileFlag
 *   - storage/file-manager                → validateFileForChatContext
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))

const getFlaggedFileIdsMock = vi.fn()
const toggleFileFlagMock = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () => ({
  getFlaggedFileIds: getFlaggedFileIdsMock,
  toggleFileFlag: toggleFileFlagMock,
}))

const validateMock = vi.fn()
vi.mock('../main/storage/file-manager', () => ({
  validateFileForChatContext: validateMock,
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
  | { ok: false; code: 'MISSING' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE'; message: string }
type ToggleHandlerFn = (
  _event: unknown,
  data: { companyId: string; fileId: string; fileName: string }
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
    getFlaggedFileIdsMock.mockReturnValue([])
    toggleFileFlagMock.mockReturnValue(true)
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

  it('skips validation when toggling OFF an already-flagged file', () => {
    getFlaggedFileIdsMock.mockReturnValue(['/path/missing.pdf'])
    toggleFileFlagMock.mockReturnValue(false)

    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/path/missing.pdf',
      fileName: 'missing.pdf',
    })

    expect(validateMock).not.toHaveBeenCalled()
    expect(toggleFileFlagMock).toHaveBeenCalledWith(
      'co-1',
      '/path/missing.pdf',
      'missing.pdf',
      undefined,
    )
    expect(result).toEqual({ ok: true, flagged: false })
  })

  it('returns ok:false code:MISSING when file does not exist', () => {
    validateMock.mockReturnValue({ ok: false, code: 'MISSING', message: 'File not found' })
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/no/such.pdf',
      fileName: 'such.pdf',
    })
    expect(result).toEqual({ ok: false, code: 'MISSING', message: 'File not found' })
    expect(toggleFileFlagMock).not.toHaveBeenCalled()
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
    expect(toggleFileFlagMock).not.toHaveBeenCalled()
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
    expect(toggleFileFlagMock).not.toHaveBeenCalled()
  })

  it('flags a valid file and returns ok:true flagged:true', () => {
    toggleFileFlagMock.mockReturnValue(true)
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '/memo.pdf',
      fileName: 'memo.pdf',
    })
    expect(validateMock).toHaveBeenCalledWith('/memo.pdf', undefined)
    expect(toggleFileFlagMock).toHaveBeenCalledWith('co-1', '/memo.pdf', 'memo.pdf', undefined)
    expect(result).toEqual({ ok: true, flagged: true })
  })

  it('passes mimeType through to validator and toggleFileFlag for Google native files (phase 2)', () => {
    toggleFileFlagMock.mockReturnValue(true)
    const result = toggleHandler!(null, {
      companyId: 'co-1',
      fileId: '1ABC_doc',
      fileName: 'Q2 partner memo',
      mimeType: 'application/vnd.google-apps.document',
    })
    expect(validateMock).toHaveBeenCalledWith('1ABC_doc', 'application/vnd.google-apps.document')
    expect(toggleFileFlagMock).toHaveBeenCalledWith(
      'co-1',
      '1ABC_doc',
      'Q2 partner memo',
      'application/vnd.google-apps.document',
    )
    expect(result).toEqual({ ok: true, flagged: true })
  })
})
