import { app, shell, BrowserWindow, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getUpcomingEvents } from './google-calendar'
import { isCalendarConnected } from './google-auth'
import { MEETING_APPS } from '../../shared/constants/meeting-apps'
import type { CalendarEvent } from '../../shared/types/calendar'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'
import { getCurrentUserId, getCurrentUserProfile } from '../security/current-user'
import { getStoragePath } from '../storage/paths'
import { prepareMeetingFromCalendarEvent } from '../ipc/meeting.ipc'

const POLL_INTERVAL_MS = 20 * 1000 // Check every 20 seconds
const NOTIFY_LEAD_MS = 2 * 60 * 1000 // Notify up to 2 minutes before start
const NOTIFY_GRACE_MS = 90 * 1000 // Still notify up to 90s after start (catch app-just-launched)
const IMMEDIATE_CHECK_DEBOUNCE_MS = 3000
const STATE_LOOKBACK_MS = 6 * 3600 * 1000 // Retain notified records for 6h past event end

type NotifiedRecord = { id: string; endTime: string }

// Track which events we've already notified about (persisted across restarts)
let notifiedRecords: NotifiedRecord[] = []
const notifiedEventIds = new Set<string>()

let pollInterval: ReturnType<typeof setInterval> | null = null
let lastImmediateCheck = 0
let runningCheck: Promise<void> | null = null

// Keep references to active notifications to prevent GC from detaching click handlers
const activeNotifications = new Set<Notification>()

function stateFile(): string {
  return join(getStoragePath(), 'meeting-notifier-state.json')
}

function loadNotifiedIds(): void {
  try {
    if (!existsSync(stateFile())) return
    const raw = JSON.parse(readFileSync(stateFile(), 'utf-8')) as NotifiedRecord[]
    if (!Array.isArray(raw)) return
    const cutoff = Date.now() - STATE_LOOKBACK_MS
    notifiedRecords = raw.filter((r) => {
      if (!r || typeof r.id !== 'string' || typeof r.endTime !== 'string') return false
      const end = new Date(r.endTime).getTime()
      return Number.isFinite(end) && end > cutoff
    })
    notifiedEventIds.clear()
    notifiedRecords.forEach((r) => notifiedEventIds.add(r.id))
    console.log(`[MeetingNotifier] Loaded ${notifiedRecords.length} notified record(s) from state`)
  } catch (err) {
    console.warn('[MeetingNotifier] state load failed:', err)
    notifiedRecords = []
    notifiedEventIds.clear()
  }
}

function persistNotifiedIds(): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(notifiedRecords), 'utf-8')
  } catch (err) {
    console.warn('[MeetingNotifier] state persist failed:', err)
  }
}

function markNotified(event: CalendarEvent): void {
  if (notifiedEventIds.has(event.id)) return
  notifiedRecords.push({ id: event.id, endTime: event.endTime })
  notifiedEventIds.add(event.id)
  persistNotifiedIds()

  // Persist a 'scheduled' meeting row so the event survives the notification
  // dismissal — without this, dismissing a notification left no DB trace and
  // the user could never find the meeting later. Idempotent via
  // findMeetingByCalendarEventId inside the helper.
  try {
    prepareMeetingFromCalendarEvent(
      {
        id: event.id,
        title: event.title,
        startTime: event.startTime,
        platform: event.platform,
        meetingUrl: event.meetingUrl,
        attendees: event.attendees,
        attendeeEmails: event.attendeeEmails,
        selfName: event.selfName,
      },
      getCurrentUserId(),
    )
  } catch (err) {
    console.error(
      `[MeetingNotifier] persist failed eventId=${event.id} metric=meeting.notifier_persist.failed count=1`,
      err,
    )
  }
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function focusAndRecord(event: CalendarEvent): void {
  const win = getMainWindow()
  if (win) {
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.send('notification:start-recording', {
      title: event.title,
      calendarEventId: event.id,
      meetingUrl: event.meetingUrl
    })
  }
}

function getPlatformDisplayName(platform: MeetingPlatform | null): string | null {
  if (!platform || platform === 'other') return null
  return MEETING_APPS[platform]?.name ?? null
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatNotificationBody(event: CalendarEvent): string {
  const parts: string[] = [`Starting at ${formatTime(event.startTime)}`]
  const platformName = getPlatformDisplayName(event.platform)
  if (platformName) {
    parts.push(`via ${platformName}`)
  }
  if (event.attendees.length > 0) {
    const count = event.attendees.length
    parts.push(`${count} attendee${count !== 1 ? 's' : ''}`)
  }
  return parts.join(' • ')
}

async function showMeetingNotification(event: CalendarEvent): Promise<void> {
  console.log('[MeetingNotifier] Showing notification for:', event.title)

  if (!Notification.isSupported()) {
    console.warn('[MeetingNotifier] Notifications not supported, falling back to focus+record')
    focusAndRecord(event)
    return
  }

  // Bounce dock icon on macOS for extra attention
  if (process.platform === 'darwin') {
    app.dock?.bounce('critical')
  }

  const notification = new Notification({
    title: 'Meeting starting soon — click to start',
    subtitle: event.title,
    body: formatNotificationBody(event),
    silent: false
  })

  activeNotifications.add(notification)

  notification.on('click', () => {
    console.log('[MeetingNotifier] Starting meeting for:', event.title)

    // Open the meeting URL externally (Zoom, Meet, Teams, etc.)
    if (event.meetingUrl) {
      let url = event.meetingUrl
      try {
        const parsed = new URL(url)
        if (parsed.hostname === 'meet.google.com') {
          const email = getCurrentUserProfile().email
          if (email) parsed.searchParams.set('authuser', email)
          url = parsed.toString()
        }
      } catch {
        // Bad URL — open as-is
      }
      shell.openExternal(url).catch((err) => {
        console.error('[MeetingNotifier] Failed to open meeting URL:', err)
      })
    } else {
      // No URL was extracted from the calendar event. Log enough to debug
      // (but not the description itself — it can hold PII/meeting passwords).
      console.warn('[MeetingNotifier] No meetingUrl on click; cannot auto-launch', {
        eventId: event.id,
        title: event.title,
        platform: event.platform,
        descriptionLength: event.description?.length ?? 0,
      })
    }

    // Focus Cyggie window and start recording
    focusAndRecord(event)
    notification.close()
    activeNotifications.delete(notification)
  })

  notification.on('close', () => {
    activeNotifications.delete(notification)
  })

  notification.show()
}

async function checkUpcomingMeetings(): Promise<void> {
  if (!isCalendarConnected()) {
    console.log('[MeetingNotifier] Calendar not connected, skipping check')
    return
  }

  try {
    const events = await getUpcomingEvents(1) // Next hour
    const now = Date.now()

    console.log(`[MeetingNotifier] Found ${events.length} upcoming event(s)`)

    for (const event of events) {
      if (notifiedEventIds.has(event.id)) continue

      const start = new Date(event.startTime).getTime()
      const end = new Date(event.endTime).getTime()
      const timeUntilStart = start - now
      const minutesUntil = Math.round((timeUntilStart / 1000 / 60) * 10) / 10

      const inLeadWindow = timeUntilStart > 0 && timeUntilStart <= NOTIFY_LEAD_MS
      const justStarted = timeUntilStart <= 0 && -timeUntilStart <= NOTIFY_GRACE_MS
      const stillRunning = Number.isFinite(end) ? end > now : true

      console.log(
        `[MeetingNotifier] "${event.title}" starts in ${minutesUntil} min ` +
          `(inLead=${inLeadWindow}, justStarted=${justStarted}, stillRunning=${stillRunning})`
      )

      if ((inLeadWindow || justStarted) && stillRunning) {
        console.log(`[MeetingNotifier] Triggering notification for "${event.title}"`)
        markNotified(event)
        showMeetingNotification(event)
      }
    }

    // Clean up records whose events have ended (past the lookback retention).
    const cutoff = now - STATE_LOOKBACK_MS
    const beforeCount = notifiedRecords.length
    notifiedRecords = notifiedRecords.filter((r) => {
      const recordEnd = new Date(r.endTime).getTime()
      return Number.isFinite(recordEnd) && recordEnd > cutoff
    })
    if (notifiedRecords.length !== beforeCount) {
      notifiedEventIds.clear()
      notifiedRecords.forEach((r) => notifiedEventIds.add(r.id))
      persistNotifiedIds()
    }
  } catch (err) {
    console.error('[MeetingNotifier] Error checking upcoming meetings:', err)
  }
}

async function runCheckOnce(): Promise<void> {
  if (runningCheck) {
    await runningCheck
    return
  }
  runningCheck = checkUpcomingMeetings().finally(() => {
    runningCheck = null
  })
  await runningCheck
}

export function startMeetingNotifier(): void {
  stopMeetingNotifier()
  loadNotifiedIds()
  console.log(
    `[MeetingNotifier] Started — polling every ${POLL_INTERVAL_MS / 1000}s, ` +
      `lead ${NOTIFY_LEAD_MS / 1000}s, grace ${NOTIFY_GRACE_MS / 1000}s`
  )
  // Run an initial check immediately
  runCheckOnce()
  pollInterval = setInterval(() => {
    runCheckOnce()
  }, POLL_INTERVAL_MS)
}

export function stopMeetingNotifier(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    console.log('[MeetingNotifier] Stopped')
  }
}

/**
 * Run a fresh check now, debounced so rapid bursts collapse to one. Call this
 * after a calendar refresh so newly-added meetings inside the lead window get
 * evaluated immediately instead of waiting for the next poll.
 */
export function triggerImmediateCheck(): void {
  const now = Date.now()
  if (now - lastImmediateCheck < IMMEDIATE_CHECK_DEBOUNCE_MS) return
  lastImmediateCheck = now
  runCheckOnce()
}

// Exported for tests only — do not use from production code.
export const __test = {
  loadNotifiedIds,
  persistNotifiedIds,
  resetState(): void {
    notifiedRecords = []
    notifiedEventIds.clear()
    lastImmediateCheck = 0
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
  },
  getNotifiedRecords(): NotifiedRecord[] {
    return [...notifiedRecords]
  },
  checkUpcomingMeetings,
  stateFile,
  constants: {
    POLL_INTERVAL_MS,
    NOTIFY_LEAD_MS,
    NOTIFY_GRACE_MS,
    IMMEDIATE_CHECK_DEBOUNCE_MS,
    STATE_LOOKBACK_MS
  }
}
