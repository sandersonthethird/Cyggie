/**
 * window.ipc.ts — pop-out window management
 *
 * Tracks open pop-out windows by noteId (Map prevents duplicates).
 * Clicking ⤢ on an already-open note focuses the existing window.
 *
 *   renderer invokes APP_OPEN_NOTE_WINDOW(noteId)
 *          │
 *          ▼
 *   popoutWindows.has(noteId) ──yes──► existing.focus(); return
 *          │ no
 *          ▼
 *   new BrowserWindow(…) → loadURL/loadFile(?popout=true#/note/:id)
 *   popoutWindows.set(noteId, win)
 *   win.on('closed') → popoutWindows.delete(noteId)
 */

import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'

const popoutWindows = new Map<string, BrowserWindow>()

export function registerWindowHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_NOTE_WINDOW, (_event, noteId: string) => {
    if (!noteId || typeof noteId !== 'string') return

    const existing = popoutWindows.get(noteId)
    if (existing && !existing.isDestroyed()) {
      console.log(`[popout] focusing existing window for ${noteId}`)
      existing.focus()
      return
    }

    console.log(`[popout] opening note window for ${noteId}`)
    let win: BrowserWindow
    try {
      win = new BrowserWindow({
        width: 800,
        height: 700,
        minWidth: 600,
        minHeight: 400,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 15, y: 10 },
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
    } catch (err) {
      console.error(`[popout] failed to create window for ${noteId}:`, err)
      return
    }

    popoutWindows.set(noteId, win)
    win.on('closed', () => popoutWindows.delete(noteId))

    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}?popout=true#/note/${noteId}`
      )
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), {
        search: 'popout=true',
        hash: `/note/${noteId}`,
      })
    }
  })
}
