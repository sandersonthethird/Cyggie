import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/constants/channels'
import type { ElectronAPI, IpcChannel } from '../shared/types/ipc'

// preload/index.ts — renderer ↔ main bridge with a strict channel allowlist.
//
//                                    ┌─────────────────┐
//   renderer ─ api.invoke(channel) ─► │ ALLOWED?        │ ─ no ─► throw
//                                    │ (set built from │
//                                    │  IPC_CHANNELS)  │ ─ yes ─► ipcRenderer.invoke(...)
//                                    └─────────────────┘
//
// The allowlist blocks an XSS-injected renderer script from inventing a
// channel name to call a handler that has no business being exposed. It does
// NOT prevent the same script from calling any of the legitimate channels —
// that's PR2's job (capability flows for FILE_READ_CONTENT / APP_OPEN_PATH
// and named methods for sensitive channels like SETTINGS_TEST_LLM_KEY).
//
// `invoke` throws on a bad channel because callers expect a Promise and a
// reject is the natural error path. `send`/`on`/`once` are fire-and-forget,
// so they no-op with a console.warn to keep the renderer alive even if a
// rogue listener gets registered.

const ALLOWED_CHANNELS = new Set<string>(Object.values(IPC_CHANNELS))

function rejectIfBlocked(channel: string, op: 'invoke' | 'send' | 'on' | 'once'): boolean {
  if (ALLOWED_CHANNELS.has(channel)) return false
  // Swallow programming errors in send/on/once; surface them on invoke.
  if (op === 'invoke') return true
  // eslint-disable-next-line no-console
  console.warn(`[preload] ${op}: channel not allowed: ${channel}`)
  return true
}

const api: ElectronAPI = {
  invoke: <T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<T> => {
    if (rejectIfBlocked(channel, 'invoke')) {
      return Promise.reject(new Error(`Channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  send: (channel: IpcChannel, ...args: unknown[]): void => {
    if (rejectIfBlocked(channel, 'send')) return
    ipcRenderer.send(channel, ...args)
  },
  on: (channel: IpcChannel, callback: (...args: unknown[]) => void): (() => void) => {
    if (rejectIfBlocked(channel, 'on')) return () => {}
    const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },
  once: (channel: IpcChannel, callback: (...args: unknown[]) => void): void => {
    if (rejectIfBlocked(channel, 'once')) return
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  },
  getPathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
}

contextBridge.exposeInMainWorld('api', api)
