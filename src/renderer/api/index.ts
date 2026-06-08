/**
 * Transport abstraction over window.api.
 *
 * All renderer code should import from here instead of calling window.api directly.
 * When migrating to the web app, swap the implementation of each method to use
 * fetch/WebSocket without touching any call sites.
 */

import type { IpcChannel } from '../../shared/types/ipc'
import { ipcCache, MUTATION_INVALIDATIONS } from './ipcCache'

const SLOW_INVOKE_MS = 50

function instrumentedInvoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const start = import.meta.env.DEV ? performance.now() : 0
  return window.api.invoke<T>(channel, ...args)
    .then((value) => {
      const toInvalidate = MUTATION_INVALIDATIONS[channel]
      if (toInvalidate) {
        for (const target of toInvalidate) ipcCache.invalidate(target)
      }
      return value
    })
    .finally(() => {
      if (!import.meta.env.DEV) return
      const ms = performance.now() - start
      if (ms >= SLOW_INVOKE_MS) {
        console.warn(`[ipc-perf] ${channel} ${ms.toFixed(1)}ms`)
      } else {
        console.debug(`[ipc-perf] ${channel} ${ms.toFixed(1)}ms`)
      }
    })
}

export const api = {
  invoke: <T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<T> =>
    instrumentedInvoke<T>(channel, ...args),

  send: (channel: IpcChannel, ...args: unknown[]): void =>
    window.api.send(channel, ...args),

  on: (channel: IpcChannel, callback: (...args: unknown[]) => void): (() => void) =>
    window.api.on(channel, callback),

  once: (channel: IpcChannel, callback: (...args: unknown[]) => void): void =>
    window.api.once(channel, callback),

  getPathForFile: (file: File): string | null =>
    window.api.getPathForFile ? window.api.getPathForFile(file) : null,
}
