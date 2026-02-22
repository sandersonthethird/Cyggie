import { app, BrowserWindow, protocol, shell } from 'electron'
import { join, normalize, extname } from 'path'
import { existsSync, statSync, createReadStream } from 'fs'
import { Readable } from 'stream'
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
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
])

// Enable system audio loopback capture (must be called before app.whenReady)
// CoreAudioTap is required on macOS 15+ — ScreenCaptureKit produces ended
// audio tracks on this OS version. The "Screen & System Audio Recording"
// permission covers CoreAudioTap despite the separate permission category.
initAudioLoopback({ forceCoreAudioTap: true })

let mainWindow: BrowserWindow | null = null
let isQuitting = false

function getMediaContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return extension === '.mp4'
    ? 'video/mp4'
    : extension === '.webm'
      ? 'video/webm'
      : 'application/octet-stream'
}

function withCorsHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Type,Content-Length,Accept-Ranges,Content-Range'
  }
}

function parseUnsignedInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  // Accept single-range and multi-range headers (use the first range only):
  // bytes=0-499,1000-1499
  const unitMatch = rangeHeader.match(/^bytes\s*=\s*(.+)$/i)
  if (!unitMatch?.[1]) return null

  const firstRange = unitMatch[1].split(',')[0]?.trim()
  if (!firstRange) return null

  const dashIndex = firstRange.indexOf('-')
  if (dashIndex < 0) return null

  const startRaw = firstRange.slice(0, dashIndex).trim()
  const endRaw = firstRange.slice(dashIndex + 1).trim()

  let start: number
  let end: number

  if (startRaw === '' && endRaw === '') {
    return null
  }

  // Suffix range: "bytes=-500" (last 500 bytes)
  if (startRaw === '') {
    const suffixLength = parseUnsignedInt(endRaw)
    if (!suffixLength || suffixLength <= 0) return null
    start = Math.max(fileSize - suffixLength, 0)
    end = fileSize - 1
  } else {
    const parsedStart = parseUnsignedInt(startRaw)
    if (parsedStart === null) return null
    start = parsedStart
    if (endRaw === '') {
      end = fileSize - 1
    } else {
      const parsedEnd = parseUnsignedInt(endRaw)
      if (parsedEnd === null) return null
      end = parsedEnd
    }
  }

  if (fileSize <= 0) return null
  if (start >= fileSize) return null
  if (end < start) return null

  end = Math.min(end, fileSize - 1)
  return { start, end }
}

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

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL()
    if (url !== currentUrl && /^https?:\/\//i.test(url)) {
      event.preventDefault()
      void shell.openExternal(url)
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

  // Handle media:// protocol — serve files from the recordings directory with explicit range support
  // so the video element can seek reliably.
  protocol.handle('media', async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: withCorsHeaders({})
      })
    }

    const url = new URL(request.url)
    const filename = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const recordingsDir = normalize(join(getRecordingsDir(), '/'))
    const filePath = normalize(join(recordingsDir, filename))
    // Ensure the resolved path stays inside the recordings directory
    if (!filePath.startsWith(recordingsDir)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!existsSync(filePath)) {
      return new Response('Not Found', { status: 404 })
    }

    const contentType = getMediaContentType(filePath)
    const fileSize = statSync(filePath).size
    const rangeHeader = request.headers.get('range')

    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, fileSize)
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: withCorsHeaders({
            'Content-Range': `bytes */${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType
          })
        })
      }

      const chunkSize = range.end - range.start + 1
      const responseHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`
      }
      if (request.method === 'HEAD') {
        return new Response(null, { status: 206, headers: withCorsHeaders(responseHeaders) })
      }

      const stream = createReadStream(filePath, { start: range.start, end: range.end })
      const body = Readable.toWeb(stream) as unknown as BodyInit
      return new Response(body, {
        status: 206,
        headers: withCorsHeaders(responseHeaders)
      })
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: withCorsHeaders({
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize)
        })
      })
    }

    const fullStream = createReadStream(filePath)
    const body = Readable.toWeb(fullStream) as unknown as BodyInit
    return new Response(body, {
      status: 200,
      headers: withCorsHeaders({
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize)
      })
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
