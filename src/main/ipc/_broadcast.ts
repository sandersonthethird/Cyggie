/**
 * Cross-window IPC broadcast helper.
 *
 * Sends `channel + payload` to every non-destroyed BrowserWindow. Used
 * by handlers that return optimistically and later need to push a
 * completion (or error) event to the renderer — e.g. VIDEO_FINALIZED,
 * RECORDING_FINALIZED, company-file-flags updates.
 *
 * The destroyed-window guard matters because send() on a closed
 * webContents throws.
 */
import { BrowserWindow } from 'electron'

export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
