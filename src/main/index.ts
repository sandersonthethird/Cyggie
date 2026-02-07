import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { initMain as initAudioLoopback } from 'electron-audio-loopback'
import { createTray } from './tray'
import { getDatabase } from './database/connection'
import { registerAllHandlers } from './ipc'
import { initializeStorage, setStoragePath } from './storage/paths'
import * as settingsRepo from './database/repositories/settings.repo'
import { cleanupStaleRecordings, cleanupExpiredScheduledMeetings } from './database/repositories/meeting.repo'

// Enable system audio loopback capture (must be called before app.whenReady)
// CoreAudioTap is required on macOS 15+ — ScreenCaptureKit produces ended
// audio tracks on this OS version. The "Screen & System Audio Recording"
// permission covers CoreAudioTap despite the separate permission category.
initAudioLoopback({ forceCoreAudioTap: true })

let mainWindow: BrowserWindow | null = null
let isQuitting = false

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      window.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  // Initialize default storage paths and database
  initializeStorage()
  getDatabase()

  // Reset any meetings stuck in "recording" status from a previous session
  const stale = cleanupStaleRecordings()
  if (stale > 0) console.log(`[Startup] Reset ${stale} stale recording(s) to error status`)

  // Remove scheduled meetings whose time has passed (prepared but never recorded)
  const expired = cleanupExpiredScheduledMeetings()
  if (expired > 0) console.log(`[Startup] Removed ${expired} expired scheduled meeting(s)`)

  // Load user-configured storage path (DB must be ready first)
  const savedStoragePath = settingsRepo.getSetting('storagePath')
  if (savedStoragePath) {
    setStoragePath(savedStoragePath)
  }

  // System audio loopback is handled by electron-audio-loopback's IPC
  // handlers (enable-loopback-audio / disable-loopback-audio) registered
  // by initAudioLoopback() above. The renderer enables the handler
  // just before calling getDisplayMedia and disables it after.

  // Register IPC handlers
  registerAllHandlers()

  // Create window and tray
  mainWindow = createWindow()
  createTray(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
