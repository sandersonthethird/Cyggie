import { IPC_CHANNELS } from '../constants/channels'

/**
 * Compile-time narrowing for IPC channel names. Layered on top of the runtime
 * allowlist in src/preload/index.ts. A renderer call site like
 * `api.invoke('not-a-channel')` becomes a TS error in addition to the runtime
 * `throw Error('Channel not allowed: not-a-channel')`.
 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface ElectronAPI {
  invoke: <T = unknown>(channel: IpcChannel, ...args: unknown[]) => Promise<T>
  send: (channel: IpcChannel, ...args: unknown[]) => void
  on: (channel: IpcChannel, callback: (...args: unknown[]) => void) => () => void
  once: (channel: IpcChannel, callback: (...args: unknown[]) => void) => void
  getPathForFile?: (file: File) => string | null
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
