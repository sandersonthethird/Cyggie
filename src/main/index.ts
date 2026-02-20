import { app, BrowserWindow, net, protocol } from 'electron'
import { join, normalize } from 'path'
import { pathToFileURL } from 'url'
import { initMain as initAudioLoopback } from 'electron-audio-loopback'
import { createTray } from './tray'
import { getDatabase } from './database/connection'
import { registerAllHandlers } from './ipc'
import { initializeStorage, setStoragePath, getRecordingsDir } from './storage/paths'
import * as settingsRepo from './database/repositories/settings.repo'
import { cleanupStaleRecordings, cleanupExpiredScheduledMeetings } from './database/repositories/meeting.repo'
import { cleanupOrphanedTempFiles } from './video/video-writer'

// Register media:// as a privileged scheme so the renderer can load local
// video files through it (file:// is blocked by cross-origin restrictions).
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, bypassCSP: true } }
])

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

  // Clean up orphaned video temp files from previous crashes
  cleanupOrphanedTempFiles()

  // Load user-configured storage path (DB must be ready first)
  const savedStoragePath = settingsRepo.getSetting('storagePath')
  if (savedStoragePath) {
    setStoragePath(savedStoragePath)
  }

  // System audio loopback is handled by electron-audio-loopback's IPC
  // handlers (enable-loopback-audio / disable-loopback-audio) registered
  // by initAudioLoopback() above. The renderer enables the handler
  // just before calling getDisplayMedia and disables it after.

  // Handle media:// protocol — serves files from the recordings directory
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const filename = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const filePath = normalize(join(getRecordingsDir(), filename))
    // Ensure the resolved path stays inside the recordings directory
    if (!filePath.startsWith(getRecordingsDir())) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).href, {
      headers: request.headers
    })
  })

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
