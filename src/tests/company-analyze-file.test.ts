/**
 * Tests for the COMPANY_ANALYZE_FILE IPC handler — the critical path for
 * file-based company enhancement.
 *
 *   companyId + extraction ─► runPitchDeckAnalysis ──► noteRepo.create ─► { noteId }
 *                                       │
 *                                       ├─ returns null ─► { noteId: null, error: 'analysis_failed' }
 *                                       │
 *                                       └─ throws ───────► { noteId: null, error: 'note_creation_failed' }
 *
 * Captures the handler at registration time via a mocked ipcMain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const handlers = new Map<string, IpcHandler>()

// --- mocks -----------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => handlers.set(channel, fn),
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp' },
}))

const runPitchDeckAnalysis = vi.fn()
vi.mock('../main/services/pitch-deck-analysis.service', () => ({
  runPitchDeckAnalysis,
}))

const createNote = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/notes-base', () => ({
  makeEntityNotesRepo: () => ({
    create: createNote,
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
  }),
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'user-1',
}))

// Stub everything else company.ipc.ts touches so importing it doesn't blow up.
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  listCompanies: vi.fn(),
  getCompany: vi.fn(),
  updateCompany: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({ logAudit: vi.fn() }))
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () => ({
  getFlaggedFiles: vi.fn(() => []),
}))

const { registerCompanyHandlers } = await import('../main/ipc/company.ipc')
const CHANNEL = 'company:analyze-file'

describe('COMPANY_ANALYZE_FILE handler', () => {
  beforeEach(() => {
    handlers.clear()
    runPitchDeckAnalysis.mockReset()
    createNote.mockReset()
    try {
      registerCompanyHandlers()
    } catch {
      // Some unrelated handler may fail to register due to other un-mocked deps;
      // we only need COMPANY_ANALYZE_FILE captured, which is registered earlier
      // or later depending on order — fall through and assert below.
    }
  })

  function call(args: { companyId: string; extraction: unknown }) {
    const handler = handlers.get(CHANNEL)
    if (!handler) throw new Error(`Handler ${CHANNEL} not registered`)
    return handler({}, args.companyId, args.extraction)
  }

  it('happy path: LLM returns content, note is created, returns noteId', async () => {
    runPitchDeckAnalysis.mockResolvedValue('## Partner Sync Summary\nCompany: Acme\n\n## Full Analysis\nlots of analysis')
    createNote.mockReturnValue({ id: 'note-1', createdAt: '2026-05-16T00:00:00.000Z' })

    const result = await call({
      companyId: 'co-1',
      extraction: { rawText: 'text', sourceFilePath: null, companyName: 'Acme', sourceLabel: null },
    })

    expect(runPitchDeckAnalysis).toHaveBeenCalledTimes(1)
    expect(createNote).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ noteId: 'note-1' })
  })

  it('LLM returns null → returns { error: "analysis_failed" }', async () => {
    runPitchDeckAnalysis.mockResolvedValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await call({
      companyId: 'co-1',
      extraction: { rawText: '', sourceFilePath: null, companyName: 'Acme', sourceLabel: null },
    })

    expect(createNote).not.toHaveBeenCalled()
    expect(result).toEqual({ noteId: null, error: 'analysis_failed' })
    warn.mockRestore()
  })

  it('note create throws → returns { error: "note_creation_failed" }', async () => {
    runPitchDeckAnalysis.mockResolvedValue('## Partner Sync Summary\nCompany: Acme\n\n## Full Analysis\nanalysis')
    createNote.mockImplementation(() => { throw new Error('DB locked') })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await call({
      companyId: 'co-1',
      extraction: { rawText: 'text', sourceFilePath: null, companyName: 'Acme', sourceLabel: null },
    })

    expect(result).toEqual({ noteId: null, error: 'note_creation_failed' })
    errSpy.mockRestore()
  })

  it('throws on missing companyId', async () => {
    await expect(call({ companyId: '', extraction: {} })).rejects.toThrow(/companyId is required/)
  })

  it('throws on missing extractionResult', async () => {
    const handler = handlers.get(CHANNEL)!
    await expect(handler({}, 'co-1', null)).rejects.toThrow(/extractionResult is required/)
  })
})
