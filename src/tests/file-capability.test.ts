import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron before importing handlers so ipcMain.handle is captured.
const handlerMap = new Map<string, (...args: unknown[]) => unknown>()
const shellOpenPath = vi.fn().mockResolvedValue('')

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlerMap.set(channel, fn)
    },
  },
  shell: {
    openPath: (...args: unknown[]) => shellOpenPath(...args),
    openExternal: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn().mockReturnValue('/tmp') },
}))

// Mock the flagged-files repo
let flagged: Array<{ companyId: string; fileId: string; fileName: string; mimeType: string | null }> = []
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () => ({
  isFlaggedAnywhere: (fileId: string) => flagged.some((f) => f.fileId === fileId),
  isFlaggedForCompany: (companyId: string, fileId: string) =>
    flagged.some((f) => f.companyId === companyId && f.fileId === fileId),
  toggleFileFlag: (companyId: string, fileId: string, fileName: string, mimeType?: string | null) => {
    const idx = flagged.findIndex((f) => f.companyId === companyId && f.fileId === fileId)
    if (idx >= 0) {
      flagged.splice(idx, 1)
      return false
    }
    flagged.push({ companyId, fileId, fileName, mimeType: mimeType ?? null })
    return true
  },
  getFlaggedFiles: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      mimeType: f.mimeType,
    })),
  getFlaggedFileIds: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => f.fileId),
}))

// Mock the file-manager readLocalFile
vi.mock('../main/storage/file-manager', () => ({
  readLocalFile: vi.fn(async (path: string) => `[content of ${path}]`),
  readTranscript: vi.fn(),
  readSummary: vi.fn(),
  updateTranscriptContent: vi.fn(),
  updateSummaryContent: vi.fn(),
  deleteTranscript: vi.fn(),
  deleteSummary: vi.fn(),
  deleteRecording: vi.fn(),
  renameTranscript: vi.fn(),
  renameSummary: vi.fn(),
  renameRecording: vi.fn(),
}))

// Mock settings repo for APP_OPEN_USER_FOLDER tests
const settingsStore: Record<string, string> = {}
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: (key: string) => settingsStore[key] ?? null,
  setSetting: (key: string, value: string) => {
    settingsStore[key] = value
  },
  getAllSettings: () => ({ ...settingsStore }),
}))

// fs.statSync mock for the APP_OPEN_USER_FOLDER directory check
const fsStatMap = new Map<string, { isDirectory: () => boolean }>()
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    statSync: (p: string) => {
      const stat = fsStatMap.get(p)
      if (!stat) throw new Error('ENOENT: no such file or directory')
      return stat
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('')),
  }
})

// Avoid pulling in the full meeting.ipc surface — we only want the new handlers.
// Stub the heavy deps it imports so module load doesn't explode.
vi.mock('@cyggie/services/meeting-summary-recovery', () => ({ recoverSummaryFromCompanionNote: vi.fn() }))
vi.mock('@cyggie/db/sqlite/repositories/search.repo', () => ({ removeFromIndex: vi.fn() }))
vi.mock('../main/drive/google-drive', () => ({ renameFile: vi.fn() }))
vi.mock('../main/services/company-enrichment', () => ({
  enrichCompaniesForMeeting: vi.fn(),
  getCompanySuggestionsForMeeting: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({}))
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  linkMeetingCompany: vi.fn(),
  getCompany: vi.fn(),
  findCompanyIdByNameOrDomain: vi.fn(),
  unlinkMeetingCompany: vi.fn(),
  getOrCreateCompanyByName: vi.fn(),
  listMeetingCompanies: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/company.repo', () => ({
  upsert: vi.fn(),
  getByDomain: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  syncContactsFromAttendees: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({ logAudit: vi.fn() }))
vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: vi.fn().mockReturnValue('test-user'),
  getCurrentUserProfile: vi.fn(),
}))
vi.mock('../main/storage/paths', () => ({
  getStoragePath: vi.fn().mockReturnValue('/tmp/storage'),
  setStoragePath: vi.fn(),
}))
vi.mock('../main/utils/company-extractor', () => ({
  extractCompaniesFromEmails: vi.fn(),
  extractCompaniesFromAttendees: vi.fn(),
  extractDomainFromEmail: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/connection', () => ({ getDatabase: vi.fn() }))

const { registerFileHandlers } = await import('../main/ipc/file.ipc')
const { registerMeetingHandlers } = await import('../main/ipc/meeting.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

registerFileHandlers()
registerMeetingHandlers()

function call<T = unknown>(channel: string, ...args: unknown[]): T | Promise<T> {
  const fn = handlerMap.get(channel)
  if (!fn) throw new Error(`No handler registered for ${channel}`)
  return fn(null, ...args) as T | Promise<T>
}

beforeEach(() => {
  flagged = []
  shellOpenPath.mockClear()
  for (const k of Object.keys(settingsStore)) delete settingsStore[k]
  fsStatMap.clear()
})

describe('FILE_READ_BY_FLAGGED_ID', () => {
  it('returns content for an already-flagged file (strict lookup, no companyId)', async () => {
    flagged.push({ companyId: 'c1', fileId: '/tmp/a.txt', fileName: 'a.txt', mimeType: 'text/plain' })
    const out = await call<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id: '/tmp/a.txt' },
    )
    expect(out.content).toBe('[content of /tmp/a.txt]')
    expect(out.error).toBeNull()
  })

  it('auto-flags an unflagged file when companyId is provided', async () => {
    expect(flagged.length).toBe(0)
    const out = await call<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id: '/tmp/b.md', companyId: 'c2', fileName: 'b.md', mimeType: 'text/markdown' },
    )
    expect(out.content).toBe('[content of /tmp/b.md]')
    expect(flagged.length).toBe(1)
    expect(flagged[0]).toMatchObject({ companyId: 'c2', fileId: '/tmp/b.md', fileName: 'b.md' })
  })

  it('auto-flag is idempotent — calling twice leaves a single row', async () => {
    await call(IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID, {
      id: '/tmp/c.txt', companyId: 'c3', fileName: 'c.txt',
    })
    await call(IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID, {
      id: '/tmp/c.txt', companyId: 'c3', fileName: 'c.txt',
    })
    expect(flagged.length).toBe(1)
  })

  it('rejects when unflagged and no companyId is provided', async () => {
    const out = await call<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id: '/tmp/unknown.txt' },
    )
    expect(out.content).toBeNull()
    expect(out.error).toMatch(/not flagged/i)
  })

  it('rejects when the extension is not supported (even if flagged)', async () => {
    flagged.push({ companyId: 'c4', fileId: '/tmp/secret.key', fileName: 'secret.key', mimeType: null })
    const out = await call<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id: '/tmp/secret.key' },
    )
    expect(out.content).toBeNull()
    expect(out.error).toMatch(/Unsupported format/i)
  })

  it('rejects when id is missing', async () => {
    const out = await call<{ content: string | null; error: string | null }>(
      IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID,
      { id: '' },
    )
    expect(out.content).toBeNull()
    expect(out.error).toMatch(/No file id/i)
  })
})

describe('APP_OPEN_FLAGGED_FILE', () => {
  it('shell.openPath for an already-flagged file (strict)', async () => {
    flagged.push({ companyId: 'c1', fileId: '/tmp/x.pdf', fileName: 'x.pdf', mimeType: 'application/pdf' })
    await call(IPC_CHANNELS.APP_OPEN_FLAGGED_FILE, { id: '/tmp/x.pdf' })
    expect(shellOpenPath).toHaveBeenCalledWith('/tmp/x.pdf')
  })

  it('auto-flags + opens when companyId is provided', async () => {
    await call(IPC_CHANNELS.APP_OPEN_FLAGGED_FILE, {
      id: '/tmp/y.pdf', companyId: 'c2', fileName: 'y.pdf', mimeType: 'application/pdf',
    })
    expect(flagged.length).toBe(1)
    expect(shellOpenPath).toHaveBeenCalledWith('/tmp/y.pdf')
  })

  it('rejects an unflagged id with no companyId', async () => {
    await expect(call(IPC_CHANNELS.APP_OPEN_FLAGGED_FILE, { id: '/etc/passwd' })).rejects.toThrow(
      /not flagged/i,
    )
    expect(shellOpenPath).not.toHaveBeenCalled()
  })

  it('rejects when id is missing', async () => {
    await expect(call(IPC_CHANNELS.APP_OPEN_FLAGGED_FILE, { id: '' })).rejects.toThrow()
  })
})

describe('APP_OPEN_USER_FOLDER', () => {
  it('opens companyLocalFilesRoot when it points to an existing directory', async () => {
    settingsStore['companyLocalFilesRoot'] = '/Users/me/Company'
    fsStatMap.set('/Users/me/Company', { isDirectory: () => true })
    await call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'companyLocalFilesRoot')
    expect(shellOpenPath).toHaveBeenCalledWith('/Users/me/Company')
  })

  it('rejects when the setting points to a non-existent path', async () => {
    settingsStore['companyLocalFilesRoot'] = '/Users/me/Missing'
    // no fsStatMap entry → stat throws ENOENT
    await expect(call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'companyLocalFilesRoot')).rejects.toThrow(
      /does not exist/i,
    )
    expect(shellOpenPath).not.toHaveBeenCalled()
  })

  it('rejects when the setting points to a file (not a directory)', async () => {
    settingsStore['companyLocalFilesRoot'] = '/Users/me/file.txt'
    fsStatMap.set('/Users/me/file.txt', { isDirectory: () => false })
    await expect(call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'companyLocalFilesRoot')).rejects.toThrow(
      /not a directory/i,
    )
    expect(shellOpenPath).not.toHaveBeenCalled()
  })

  it('rejects when the setting is unset', async () => {
    await expect(call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'companyLocalFilesRoot')).rejects.toThrow(
      /not configured/i,
    )
  })

  it('rejects unknown which values', async () => {
    await expect(call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'storagePath')).rejects.toThrow(
      /Unsupported user-folder key/i,
    )
    await expect(call(IPC_CHANNELS.APP_OPEN_USER_FOLDER, '')).rejects.toThrow()
  })
})
