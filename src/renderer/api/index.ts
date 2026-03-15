/**
 * Transport abstraction over window.api.
 *
 * All renderer code should import from here instead of calling window.api directly.
 * When migrating to the web app, swap the implementation of each method to use
 * fetch/WebSocket without touching any call sites.
 */
export const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    window.api.invoke<T>(channel, ...args),

  send: (channel: string, ...args: unknown[]): void =>
    window.api.send(channel, ...args),

  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) =>
    window.api.on(channel, callback),

  once: (channel: string, callback: (...args: unknown[]) => void): void =>
    window.api.once(channel, callback),

  getPathForFile: (file: File): string | null =>
    window.api.getPathForFile ? window.api.getPathForFile(file) : null,
}
