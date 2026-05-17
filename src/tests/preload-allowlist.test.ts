import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC_CHANNELS } from '../shared/constants/channels'

// Mock Electron BEFORE importing the preload so contextBridge.exposeInMainWorld
// captures our spy and we can introspect the exposed api shape.
const exposedApi: { current: unknown } = { current: null }
const ipcInvoke = vi.fn()
const ipcSend = vi.fn()
const ipcOn = vi.fn()
const ipcRemove = vi.fn()
const ipcOnce = vi.fn()
const webUtilsGet = vi.fn().mockReturnValue('/tmp/x')

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      exposedApi.current = api
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => ipcInvoke(...args),
    send: (...args: unknown[]) => ipcSend(...args),
    on: (...args: unknown[]) => ipcOn(...args),
    once: (...args: unknown[]) => ipcOnce(...args),
    removeListener: (...args: unknown[]) => ipcRemove(...args),
  },
  webUtils: { getPathForFile: (...args: unknown[]) => webUtilsGet(...args) },
}))

// Importing the preload module runs `contextBridge.exposeInMainWorld(...)`
// which captures the api into `exposedApi.current`.
await import('../preload/index')

interface PreloadApi {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  once: (channel: string, cb: (...args: unknown[]) => void) => void
}

function getApi(): PreloadApi {
  if (!exposedApi.current) throw new Error('preload api not captured — did the module load?')
  return exposedApi.current as PreloadApi
}

beforeEach(() => {
  ipcInvoke.mockClear()
  ipcSend.mockClear()
  ipcOn.mockClear()
  ipcRemove.mockClear()
  ipcOnce.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const REAL_CHANNEL = IPC_CHANNELS.MEETING_LIST
const FAKE_CHANNEL = 'not-a-real-channel'

describe('preload channel allowlist', () => {
  it('invoke forwards allowed channels to ipcRenderer.invoke', async () => {
    ipcInvoke.mockResolvedValue('ok')
    const result = await getApi().invoke(REAL_CHANNEL, 'arg1')
    expect(result).toBe('ok')
    expect(ipcInvoke).toHaveBeenCalledWith(REAL_CHANNEL, 'arg1')
  })

  it('invoke rejects on a non-allowlisted channel', async () => {
    await expect(getApi().invoke(FAKE_CHANNEL)).rejects.toThrow(/Channel not allowed/)
    expect(ipcInvoke).not.toHaveBeenCalled()
  })

  // PR2: the renderer-controlled-path channels were removed entirely. Any code
  // still trying to call them by string fails closed in the preload gate.
  it('invoke rejects PR2-removed channel "file:read-content"', async () => {
    await expect(getApi().invoke('file:read-content', '/etc/passwd')).rejects.toThrow(
      /Channel not allowed/,
    )
    expect(ipcInvoke).not.toHaveBeenCalled()
  })

  it('invoke rejects PR2-removed channel "app:open-path"', async () => {
    await expect(getApi().invoke('app:open-path', '/etc')).rejects.toThrow(/Channel not allowed/)
    expect(ipcInvoke).not.toHaveBeenCalled()
  })

  it('invoke allows the PR2 capability-scoped replacement channels', async () => {
    ipcInvoke.mockResolvedValue({ content: null, error: null })
    await getApi().invoke(IPC_CHANNELS.FILE_READ_BY_FLAGGED_ID, { id: 'x' })
    await getApi().invoke(IPC_CHANNELS.APP_OPEN_FLAGGED_FILE, { id: 'x' })
    await getApi().invoke(IPC_CHANNELS.APP_OPEN_USER_FOLDER, 'companyLocalFilesRoot')
    expect(ipcInvoke).toHaveBeenCalledTimes(3)
  })

  it('send forwards allowed channels and no-ops bad channels (with warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getApi().send(REAL_CHANNEL, 'payload')
    expect(ipcSend).toHaveBeenCalledWith(REAL_CHANNEL, 'payload')

    getApi().send(FAKE_CHANNEL, 'payload')
    expect(ipcSend).toHaveBeenCalledTimes(1) // still only the good call
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('on returns a noop unsubscribe for blocked channels', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unsubscribe = getApi().on(FAKE_CHANNEL, () => {})
    expect(typeof unsubscribe).toBe('function')
    expect(ipcOn).not.toHaveBeenCalled()
    // Calling the noop unsubscribe should not throw
    expect(() => unsubscribe()).not.toThrow()
    warn.mockRestore()
  })

  it('on subscribes to ipcRenderer when channel is allowed', () => {
    getApi().on(REAL_CHANNEL, () => {})
    expect(ipcOn).toHaveBeenCalledTimes(1)
    expect(ipcOn.mock.calls[0][0]).toBe(REAL_CHANNEL)
  })

  it('once no-ops on blocked channels and subscribes on allowed ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getApi().once(FAKE_CHANNEL, () => {})
    expect(ipcOnce).not.toHaveBeenCalled()

    getApi().once(REAL_CHANNEL, () => {})
    expect(ipcOnce).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
