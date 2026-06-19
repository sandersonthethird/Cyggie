import { app, BrowserWindow, dialog, nativeImage, protocol, shell } from 'electron'
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
  triggerSyncPull,
} from './services/sync-bootstrap'
import { backfillProviderKeysOnLaunch } from './services/gateway-credentials'
import { backfillWebChatModelOnLaunch } from './services/web-config-push'
// EVAL-FEATURE: transcription provider evaluation bootstrap.
import { runTranscriptionEvalMigration } from './transcription-eval/repo/migration'
import { runEvalBootCleanup } from './transcription-eval/service/boot-cleanup'
import { backfillMissingSummariesOnLaunch } from './services/summary-backfill.service'
import { backfillMemosForSyncOnLaunch } from './services/memo-sync-backfill.service'
import { backfillEmailsForSyncOnLaunch } from './services/email-sync-backfill.service'
import { backfillPreferencesForSyncOnLaunch } from './services/preference-sync.service'
import { consolidateTargetStageFieldsOnLaunch } from './services/target-stage-consolidation-backfill.service'
import { backfillCustomFieldsForSyncOnLaunch } from './services/custom-field-sync-backfill.service'
import { backfillMeetingCascadeForSyncOnLaunch } from './services/meeting-cascade-sync-backfill.service'
import { requeueFailedOutboxOnLaunch } from './services/outbox-failed-requeue.service'
import { backfillNotesPrivacyOnLaunch } from './services/notes-privacy-backfill.service'
import { startExtractionWorker } from './services/flagged-file-extraction-worker'
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
  // Show the Cyggie logo in the Dock / ⌘-Tab switcher. In `pnpm dev` the
  // running binary is stock Electron, so macOS would otherwise draw the
  // generic Electron icon; the packaged Info.plist icon only applies to a
  // built .app. setIcon() overrides it at runtime for both. (macOS ignores
  // the BrowserWindow `icon` option.)
  if (process.platform === 'darwin' && app.dock) {
    // PNG, not .icns — nativeImage can't decode .icns on macOS (returns empty).
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../build/icon.png')
    const dockIcon = nativeImage.createFromPath(iconPath)
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon)
    } else {
      console.warn('[Startup] Dock icon failed to load:', iconPath)
    }
  }

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

  // EVAL-FEATURE: create the transcription_evaluations table (idempotent)
  // and sweep any rows left in 'pending' state from a previous run that was
  // killed mid-eval. Rip-out: delete this block + the src/main/transcription-eval
  // directory.
  try {
    runTranscriptionEvalMigration()
    runEvalBootCleanup()
  } catch (err) {
    console.warn('[Startup] EVAL-FEATURE bootstrap failed (non-fatal):', err)
  }

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
  backfillProviderKeysOnLaunch()

  // Push the web-chat model up to the public web app so share chats resolve it
  // live, healing any value set before this shipped or while offline.
  void backfillWebChatModelOnLaunch()

  // Item 4 (mobile summary tab) — bring historical summary_path content
  // into the meetings.summary column so mobile's Summary tab can render
  // meetings summarized before the dual-write landed. Idempotent: WHERE
  // clause self-excludes already-backfilled rows on re-launch. Deferred
  // 2s inside the helper for the same reason as the Anthropic backfill —
  // off the critical startup path, away from the SyncAgent first tick.
  backfillMissingSummariesOnLaunch(startupUserId)

  // Memo sync backfill (2026-05-23) — memos joined the sync engine via
  // migration 101 + OWNED_TABLES additions, but historical memo + version
  // rows have no outbox entry and never reach Neon. This pass enqueues
  // one outbox INSERT per row still at lamport='0', so the mobile Memos
  // tab on company detail sees them after the next /sync/push drain.
  // Idempotent: lamport='0' is the only candidate set.
  backfillMemosForSyncOnLaunch(startupUserId)

  // Email sync backfill (Part B) — email rows are written by ingest via raw
  // SQL (not wrapped repos), so they carry no outbox entry. This pass enqueues
  // one outbox INSERT per email_messages / email_company_links /
  // email_contact_links row still at lamport='0' (body_text truncated to ~4 KB
  // in the payload), so the gateway/mobile chat context can include tagged
  // emails after the next /sync/push drain. Idempotent.
  backfillEmailsForSyncOnLaunch(startupUserId)

  // Part E — enqueue any pre-existing user_preferences rows (at lamport='0')
  // so synced chat settings (e.g. emailThreadsPerCompany) reach Neon.
  backfillPreferencesForSyncOnLaunch(startupUserId)

  // Consolidate the orphaned custom "Target Stage" / "Focus" fields into the
  // canonical built-in "Target Investment Stage" (native columns) and delete the
  // orphans. Runs at 3s, BEFORE the custom-field sync backfill (3.5s) so the
  // orphan defs are gone before survivors are enqueued. Idempotent (no-op once
  // the orphan defs are deleted). Writes flow through the wrapped barrel writers
  // → outbox → Neon.
  consolidateTargetStageFieldsOnLaunch(startupUserId)

  // Custom-field sync backfill — definitions + values joined the sync engine via
  // migrations 119/120, but rows created before that have no outbox entry. This
  // enqueues each def/value still at lamport='0' (defs before values) so mobile/
  // web see custom fields after the next /sync/push drain. Idempotent.
  backfillCustomFieldsForSyncOnLaunch(startupUserId)

  // Notes privacy backfill — one-time: mark every existing note with no company
  // tagged (untagged + contact-only) as private, syncing the flag to Neon via
  // the outbox. Run-once guarded (settings flag) so it never re-privatizes notes
  // created later. Deferred 3.6s, just after the custom-field backfill.
  backfillNotesPrivacyOnLaunch(startupUserId)

  // Meeting-cascade sync backfill — companies + contacts (and their child rows)
  // auto-created from meetings used to be written to SQLite without an outbox
  // entry, so they never reached Neon (invisible on mobile). This enqueues each
  // org_companies / org_company_aliases / meeting_company_links / contacts /
  // contact_emails row still at lamport='0' (parents before children) so they
  // sync after the next /sync/push drain. Deferred 4s; idempotent.
  backfillMeetingCascadeForSyncOnLaunch(startupUserId)

  // One-time re-drive of outbox rows the gateway rejected before the 2026-06-19
  // sync-push hardening (lossy camelToSnake on digit-suffix columns + missing
  // int→boolean coercion). Resets 'failed'/'dead' → 'pending' once so they drain
  // against the fixed gateway. Run-once guarded; deferred after the backfills.
  requeueFailedOutboxOnLaunch()

  // (The one-time pull-watermark re-pull now lives in bootstrapSync(), reset
  // synchronously before the pull service starts — see
  // resetPullWatermarkForRepullOnce in sync-repull-once.service.ts. It replaces
  // the racy deferred rehealDivergedMeetingsOnLaunch, which lost the
  // read-then-clobber race against the first in-flight pull.)

  // Phase 3 — kick the flagged-file extraction worker. Drains any
  // 'pending' or stuck-'extracting' rows (post-crash recovery), and
  // handles the migration-104 backfill (pre-Phase-3 rows enqueued by
  // the SQLite migration). The worker is durable via extraction_status;
  // notifyPending() wakes it after each flag/refresh IPC.
  startExtractionWorker()

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

  // Trigger an immediate sync pull when the desktop window regains focus.
  // Without this, cross-device latency is up to one full 60s pull tick
  // after the user switches from mobile back to desktop. The pull itself
  // is debounced inside the SyncAgent (no-op if one is already in flight).
  app.on('browser-window-focus', () => {
    triggerSyncPull()
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
