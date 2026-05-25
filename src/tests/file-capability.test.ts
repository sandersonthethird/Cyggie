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

// Mock the flagged-files repo (Phase 3 refactor: split toggleFileFlag into
// flagFile/unflagFile/refreshFlaggedFile/updateFlaggedFileExtraction; added
// detailed-row and pending-queue accessors). The barrel's withSync wrappers
// read every exported name, so stub each one even if this test doesn't
// exercise it.
let flagged: Array<{ companyId: string; fileId: string; fileName: string; mimeType: string | null }> = []
vi.mock('@cyggie/db/sqlite/repositories/company-file-flags.repo', () => ({
  isFlaggedAnywhere: (fileId: string) => flagged.some((f) => f.fileId === fileId),
  isFlaggedForCompany: (companyId: string, fileId: string) =>
    flagged.some((f) => f.companyId === companyId && f.fileId === fileId),
  flagFile: (args: { companyId: string; fileId: string; fileName: string; mimeType?: string | null }) => {
    if (flagged.some((f) => f.companyId === args.companyId && f.fileId === args.fileId)) {
      return null
    }
    flagged.push({
      companyId: args.companyId,
      fileId: args.fileId,
      fileName: args.fileName,
      mimeType: args.mimeType ?? null,
    })
    return { id: 'flag-' + flagged.length }
  },
  unflagFile: (args: { companyId: string; fileId: string }) => {
    const idx = flagged.findIndex(
      (f) => f.companyId === args.companyId && f.fileId === args.fileId,
    )
    if (idx >= 0) flagged.splice(idx, 1)
  },
  refreshFlaggedFile: vi.fn(),
  updateFlaggedFileExtraction: vi.fn(),
  getFlaggedFiles: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      mimeType: f.mimeType,
    })),
  getFlaggedFilesDetailed: vi.fn(() => []),
  getFlaggedFileIds: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => f.fileId),
  getFlaggedFileById: vi.fn(),
  getFlaggedFileByPair: vi.fn(),
  getPendingExtractionRows: vi.fn(() => []),
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
// Phase 3 — the IPC barrel pulls in meeting.repo at module-eval time
// because index.ts calls withSync(rawMeeting.createMeeting, ...). Vitest
// errors on missing-export access, so stub every name the barrel reads.
// (List derived from `grep rawMeeting\.` in repositories/index.ts.)
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  cleanupExpiredScheduledMeetings: vi.fn(),
  cleanupStaleRecordings: vi.fn(),
  computeAutoGroupEventFlag: vi.fn(),
  createMeeting: vi.fn(),
  deleteMeeting: vi.fn(),
  findMeetingByCalendarEventId: vi.fn(),
  getMeeting: vi.fn(),
  getMeetingSpeakerContactMap: vi.fn(),
  linkMeetingSpeakerContact: vi.fn(),
  listMeetings: vi.fn(),
  shouldSyncAttendees: vi.fn(),
  unlinkMeetingSpeakerContact: vi.fn(),
  updateMeeting: vi.fn(),
}))
// Phase 3 — stubbing every name the barrel reads (see `grep
// rawOrgCompany\.` in repositories/index.ts). vitest errors on
// missing-export access at module-eval; the test doesn't actually
// exercise these calls.
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  applyCompanyDedupDecisions: vi.fn(),
  clearCompanyPrimaryContact: vi.fn(),
  countStubCompanies: vi.fn(),
  createCompany: vi.fn(),
  deleteCompany: vi.fn(),
  deleteCompanyEmailLinks: vi.fn(),
  findCompanyIdByDomain: vi.fn(),
  findCompanyIdByNameOrDomain: vi.fn(),
  fixConcatenatedCompanyNames: vi.fn(),
  getCoInvestorOverlaps: vi.fn(),
  getCompaniesByNormalizedNames: vi.fn(),
  getCompany: vi.fn(),
  getCompanyCanonicalNameByDomain: vi.fn(),
  getCompanyEmailById: vi.fn(),
  getCompanyInvestorsByType: vi.fn(),
  getCompanyMergePreview: vi.fn(),
  getEntityTypeByNameOrDomain: vi.fn(),
  getOrCreateCompanyByName: vi.fn(),
  linkContactToCompany: vi.fn(),
  linkMeetingCompany: vi.fn(),
  linkMeetingsForContactCompany: vi.fn(),
  listCompanies: vi.fn(),
  listCompanyContacts: vi.fn(),
  listCompanyEmails: vi.fn(),
  listCompanyFiles: vi.fn(),
  listCompanyMeetingSummaryPaths: vi.fn(),
  listCompanyMeetings: vi.fn(),
  listCompanyTimeline: vi.fn(),
  listMeetingCompanies: vi.fn(),
  listPipelineCompanies: vi.fn(),
  listSuspectedDuplicateCompanies: vi.fn(),
  mergeCompanies: vi.fn(),
  parseInvestorsJson: vi.fn(),
  repairContactCompanyMismatches: vi.fn(),
  setCompanyInvestors: vi.fn(),
  setCompanyPrimaryContact: vi.fn(),
  unlinkContactFromCompany: vi.fn(),
  unlinkMeetingCompany: vi.fn(),
  updateCompany: vi.fn(),
  upsertCompanyClassification: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/company.repo', () => ({
  upsert: vi.fn(),
  getByDomain: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  addContactEmail: vi.fn(),
  applyContactDedupDecisions: vi.fn(),
  autoLinkContactsByDomain: vi.fn(),
  createContact: vi.fn(),
  deleteContact: vi.fn(),
  enrichContact: vi.fn(),
  enrichContactsByIds: vi.fn(),
  enrichExistingContacts: vi.fn(),
  getContact: vi.fn(),
  getContactsByIds: vi.fn(),
  hasContactEmailHistory: vi.fn(),
  listContactEmails: vi.fn(),
  listContactTimeline: vi.fn(),
  listContacts: vi.fn(),
  listContactsForEmailOnboarding: vi.fn(),
  listContactsLight: vi.fn(),
  listPastEmployeeContacts: vi.fn(),
  listSuspectedDuplicateContacts: vi.fn(),
  mergeContacts: vi.fn(),
  removeContactEmail: vi.fn(),
  resolveContactsByEmails: vi.fn(),
  resolveContactsByNormalizedNames: vi.fn(),
  setContactPrimaryCompany: vi.fn(),
  syncContactsFromAttendees: vi.fn(),
  syncContactsFromMeetings: vi.fn(),
  updateContact: vi.fn(),
  updateContactEmail: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/notes.repo', () => ({
  createFolder: vi.fn(),
  createNote: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: vi.fn(),
  getFolderCounts: vi.fn(),
  getNote: vi.fn(),
  listFolders: vi.fn(),
  listImportSources: vi.fn(),
  listNotes: vi.fn(),
  renameFolder: vi.fn(),
  searchNotes: vi.fn(),
  tagNote: vi.fn(),
  updateNote: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/chat-session.repo', () => ({
  appendMessage: vi.fn(),
  archive: vi.fn(),
  createNew: vi.fn(),
  deleteSession: vi.fn(),
  getActiveForContext: vi.fn(),
  getMessageCount: vi.fn(),
  getSession: vi.fn(),
  listRecent: vi.fn(),
  loadMessages: vi.fn(),
  pin: vi.fn(),
  rename: vi.fn(),
  search: vi.fn(),
  setCacheEnabled: vi.fn(),
  setTitleIfMissing: vi.fn(),
  unpin: vi.fn(),
}))
// Phase 3 — file.ipc + meeting.ipc now call flagFile/isFlaggedAnywhere
// from the BARREL (not the raw repo). The barrel wraps the raw fns with
// withSync, which throws in tests because configureSyncGlobals isn't
// called. Mock the barrel directly for the surfaces these handlers use;
// route flagFile/unflagFile through the same in-memory `flagged` array
// the raw-repo mock uses, so behavior matches.
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  isFlaggedAnywhere: (fileId: string) => flagged.some((f) => f.fileId === fileId),
  isFlaggedForCompany: (companyId: string, fileId: string) =>
    flagged.some((f) => f.companyId === companyId && f.fileId === fileId),
  flagFile: (args: {
    companyId: string
    fileId: string
    fileName: string
    mimeType?: string | null
  }) => {
    if (
      flagged.some((f) => f.companyId === args.companyId && f.fileId === args.fileId)
    ) {
      return null
    }
    flagged.push({
      companyId: args.companyId,
      fileId: args.fileId,
      fileName: args.fileName,
      mimeType: args.mimeType ?? null,
    })
    return { id: 'flag-' + flagged.length }
  },
  unflagFile: (args: { companyId: string; fileId: string }) => {
    const idx = flagged.findIndex(
      (f) => f.companyId === args.companyId && f.fileId === args.fileId,
    )
    if (idx >= 0) flagged.splice(idx, 1)
  },
  refreshFlaggedFile: vi.fn(),
  updateFlaggedFileExtraction: vi.fn(),
  getFlaggedFiles: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      mimeType: f.mimeType,
    })),
  getFlaggedFilesDetailed: vi.fn(() => []),
  getFlaggedFileIds: (companyId: string) =>
    flagged.filter((f) => f.companyId === companyId).map((f) => f.fileId),
  getFlaggedFileById: vi.fn(),
  getFlaggedFileByPair: vi.fn(),
  getPendingExtractionRows: vi.fn(() => []),
  // Pass-throughs needed by meeting.ipc imports.
  syncContactsFromAttendees: vi.fn(),
  computeAutoGroupEventFlag: vi.fn(),
  shouldSyncAttendees: vi.fn(),
  linkMeetingCompany: vi.fn(),
  getCompany: vi.fn(),
  findCompanyIdByNameOrDomain: vi.fn(),
  unlinkMeetingCompany: vi.fn(),
  getOrCreateCompanyByName: vi.fn(),
  listMeetingCompanies: vi.fn(),
  getDatabase: vi.fn(),
}))

// Phase 3 — file.ipc + meeting.ipc kick the extraction worker after
// flagging. Worker is in-memory; stub the notify function so the test
// doesn't need the real boot wiring.
vi.mock('../main/services/flagged-file-extraction-worker', () => ({
  notifyPending: vi.fn(),
  startExtractionWorker: vi.fn(),
}))

vi.mock('@cyggie/db/sqlite/repositories/investment-memo.repo', () => ({
  buildInitialMemoContent: vi.fn(),
  createMemo: vi.fn(),
  getLatestMemoForCompany: vi.fn(),
  getMemo: vi.fn(),
  getMemoLatestVersion: vi.fn(),
  getMemoVersion: vi.fn(),
  listMemoVersions: vi.fn(),
  listMemoVersionsSummary: vi.fn(),
  recordMemoExport: vi.fn(),
  saveMemoVersion: vi.fn(),
  updateMemoStatus: vi.fn(),
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
