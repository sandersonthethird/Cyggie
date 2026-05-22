import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { join, normalize, extname } from 'path'
import { existsSync, statSync, createReadStream } from 'fs'
import { Readable } from 'stream'
import { initMain as initAudioLoopback } from 'electron-audio-loopback'
import { createTray } from './tray'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { registerAllHandlers } from './ipc'
import { fetchAndEnrichCalendarEvents, calendarCacheKey } from './ipc/calendar.ipc'
import { persistentCache } from './cache/persistent-cache'
import { initializeStorage, setStoragePath, getRecordingsDir, getStoragePath } from './storage/paths'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { cleanupStaleRecordings, cleanupExpiredScheduledMeetings } from '@cyggie/db/sqlite/repositories'
import { cleanupOrphanedTempFiles, getActiveRecordingMeetingId } from './video/video-writer'
import { getPendingForQuit } from './ipc/_finalizations'
import { getCurrentUserId } from './security/current-user'
import {
  migrateLegacyEncryptedCredentials,
  migrateLegacyEncryptedApiKeys,
} from './security/credentials'
import {
  bootstrapSync,
  shutdownSync,
  setSyncStatusBroadcastTarget,
} from './services/sync-bootstrap'
import { backfillAnthropicKeyOnLaunch } from './services/gateway-credentials'
import { handleAuthCallback } from './auth/cyggie-auth'
import { registerCyggieAuthIpc } from './ipc/cyggie-auth.ipc'

// Register privileged schemes before app.whenReady:
//   media:// — local video files (cross-origin blocked on file://)
//   asset:// — extracted note images (base64 images saved to disk during import)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    }
  }
])

// Register cyggie-desktop:// as the OS-level URL scheme for this app.
// The gateway 302s to cyggie-desktop://auth-callback?session=&refresh=…
// at the end of the desktop sign-in flow; macOS LaunchServices/Windows-shell
// hand the URL back to the running Electron instance via open-url (macOS)
// or second-instance argv (Windows / Linux). Skipped in dev when the path
// argument form is needed on Windows; dev on macOS works without it.
app.setAsDefaultProtocolClient('cyggie-desktop')

// Single-instance lock: when the OS hands us a cyggie-desktop:// URL from a
// second app launch (Windows / Linux protocol-launch path), the original
// instance receives it via 'second-instance'. Bail if we lost the lock.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('open-url', (event, url) => {
  // macOS: protocol clicks fire this event, regardless of whether the app
  // was running or got launched by the OS.
  if (url.startsWith('cyggie-desktop://')) {
    event.preventDefault()
    void handleAuthCallback(url, mainWindow?.webContents ?? null)
  }
})

app.on('second-instance', (_event, argv) => {
  // Windows / Linux: the second-launch instance ends with the URL in argv.
  // Focus the existing window if it's hidden.
  const url = argv.find((a) => a.startsWith('cyggie-desktop://'))
  if (url) {
    void handleAuthCallback(url, mainWindow?.webContents ?? null)
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

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
      // PR3b: enabled after PR1 left the preload Node-free (no fs/path/Buffer
      // usage; only electron's contextBridge/ipcRenderer/webUtils). Chromium's
      // sandbox process now wraps the renderer for an extra defense layer.
      // LinkedIn login + enrichment windows stay unsandboxed for now —
      // tracked as P3 in TODOS.md ("LinkedIn windows sandbox audit").
      sandbox: true,
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

  // Ensure a local current-user identity exists so new writes are attributable.
  const startupUserId = getCurrentUserId()

  // One-time wipe of safeStorage-encrypted credentials in dev. Must run
  // BEFORE bootstrapSync, because the agent's first tick tries to decrypt
  // the access token — leaving a stale encrypted blob in the settings table
  // would either resurface the keychain prompt or surface garbled tokens.
  //
  // v1: OAuth tokens (shipped earlier).
  // v2: AI API keys (v1 missed these; Deepgram WS protocol crash on Record).
  migrateLegacyEncryptedCredentials()
  migrateLegacyEncryptedApiKeys()

  // Wire the desktop → Neon SyncAgent. Must run AFTER getDatabase() (so
  // migrations 096 + 097 have applied) and AFTER getCurrentUserId() (so
  // configureSyncGlobals can resolve user_id on each call).
  void startupUserId
  bootstrapSync()

  // T24 — push the user's local Anthropic key up to the gateway so
  // mobile chat uses the same value. Idempotent (gateway upserts), so
  // this both backfills first-time users and self-heals drift if the
  // gateway was wiped while the desktop was offline. Runs after a 2s
  // delay inside the helper so it doesn't compete with the SyncAgent's
  // first tick or token refresh.
  backfillAnthropicKeyOnLaunch()

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

  // Handle asset:// protocol — serve extracted note images from {storagePath}/note-assets/
  // Security: path traversal validation ensures requests stay inside the note-assets directory.
  protocol.handle('asset', (request) => {
    const url = new URL(request.url)
    const relativePath = decodeURIComponent(url.host + url.pathname)
    const allowedDir = normalize(join(getStoragePath(), 'note-assets') + '/')
    const resolved = normalize(join(getStoragePath(), relativePath))
    if (!resolved.startsWith(allowedDir)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!existsSync(resolved)) {
      return new Response('Not Found', { status: 404 })
    }
    const ext = extname(resolved).toLowerCase().slice(1)
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp'
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'
    const stream = createReadStream(resolved)
    const body = Readable.toWeb(stream) as unknown as BodyInit
    return new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
  })

  // Register IPC handlers
  registerAllHandlers()

  // One-shot startup calendar reconcile: invalidate the 1h cache so the next
  // fetch is fresh, then trigger it. This is what surfaces past calendar
  // events the notifier missed (app closed during lead window, event added
  // retroactively, this fix landing today). Fire-and-forget — UI doesn't
  // block on it.
  persistentCache.invalidate(calendarCacheKey())
  fetchAndEnrichCalendarEvents().catch((err) =>
    console.error(
      `[Startup] calendar reconcile failed metric=meeting.reconcile.startup.failed count=1`,
      err,
    ),
  )

  // Create window and tray
  mainWindow = createWindow()
  createTray(mainWindow)

  // Bind window-specific IPC + push-broadcast targets that need a webContents
  // handle. Both the Cyggie auth flow and the SyncAgent push status updates
  // to the renderer Cloud Sync panel; without a bound window they no-op
  // silently. These are safe to call multiple times — they replace the
  // previously-bound target so an activate-after-close cycle stays wired.
  registerCyggieAuthIpc(mainWindow)
  setSyncStatusBroadcastTarget(mainWindow.webContents)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

/**
 * Quit safety: two concerns layered on top of the normal quit flow.
 *
 * 1. Active recording (user clicked Quit while still recording): prompt.
 *    The recording isn't stopped yet so there are no pending finalizations
 *    to await; the user must decide whether to stop+save or cancel.
 *
 * 2. Pending background finalizations (user already clicked Stop but the
 *    background ffmpeg flush / Deepgram finalize / transcript write hasn't
 *    completed): block quit until they finish so the file lands on disk.
 *    VIDEO_STOP and RECORDING_STOP both return optimistically and register
 *    their finalize promise in the shared pending registry.
 */
let isAwaitingPendingFinalize = false

app.on('before-quit', (event) => {
  isQuitting = true

  // Stop the SyncAgent's periodic timer so Node can exit cleanly.
  shutdownSync()

  // Concern (1): active in-progress recording.
  const activeMeetingId = getActiveRecordingMeetingId()
  if (activeMeetingId) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Cancel', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Recording in progress',
      message: 'A meeting is currently recording.',
      detail: 'If you quit now, the in-progress recording will be lost. Stop the recording first to save it.',
    })
    if (choice === 0) {
      // Cancel quit; let the user stop the recording manually.
      event.preventDefault()
      isQuitting = false
      return
    }
    // Falls through to concern (2) — there may be pending finalizations too.
  }

  // Concern (2): pending background finalizations from a recent VIDEO_STOP
  // or RECORDING_STOP. The shared registry contains both.
  const pending = getPendingForQuit()
  if (pending.length > 0 && !isAwaitingPendingFinalize) {
    event.preventDefault()
    isAwaitingPendingFinalize = true
    console.log(`[before-quit] awaiting ${pending.length} pending finalization(s)`)
    Promise.allSettled(pending).finally(() => {
      console.log('[before-quit] finalizations complete, quitting')
      app.quit()
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
