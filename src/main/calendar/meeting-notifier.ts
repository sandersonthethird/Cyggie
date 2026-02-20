import { app, shell, BrowserWindow, Notification } from 'electron'
import { getUpcomingEvents } from './google-calendar'
import { isCalendarConnected } from './google-auth'
import { MEETING_APPS } from '../../shared/constants/meeting-apps'
import type { CalendarEvent } from '../../shared/types/calendar'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'

const POLL_INTERVAL_MS = 30 * 1000 // Check every 30 seconds
const NOTIFY_BEFORE_MS = 1 * 60 * 1000 // Notify 1 minute before

// Track which events we've already notified about
const notifiedEventIds = new Set<string>()
let pollInterval: ReturnType<typeof setInterval> | null = null

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function focusAndRecord(event: CalendarEvent): void {
  const win = getMainWindow()
  if (win) {
    if (!win.isVisible()) win.show()
    win.focus()
    win.webContents.send('notification:start-recording', event.title)
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
  return parts.join(' \u2022 ')
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
    app.dock.bounce('critical')
  }

  const notification = new Notification({
    title: 'Meeting starting soon — click to start',
    subtitle: event.title,
    body: formatNotificationBody(event),
    silent: false
  })

  notification.on('click', () => {
    console.log('[MeetingNotifier] Starting meeting for:', event.title)

    // Open the meeting URL externally (Zoom, Meet, Teams, etc.)
    if (event.meetingUrl) {
      shell.openExternal(event.meetingUrl).catch((err) => {
        console.error('[MeetingNotifier] Failed to open meeting URL:', err)
      })
    }

    // Focus Cyggie window and start recording
    focusAndRecord(event)
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
      const timeUntilStart = start - now
      const minutesUntil = Math.round(timeUntilStart / 1000 / 60 * 10) / 10

      console.log(
        `[MeetingNotifier] "${event.title}" starts in ${minutesUntil} min`
      )

      // Notify if meeting starts within the next 1 minute (and hasn't already started)
      if (timeUntilStart > 0 && timeUntilStart <= NOTIFY_BEFORE_MS) {
        console.log(`[MeetingNotifier] Triggering notification for "${event.title}"`)
        notifiedEventIds.add(event.id)
        showMeetingNotification(event)
      } else {
        console.log(
          `[MeetingNotifier] Not in notification window — timeUntilStart: ${timeUntilStart}ms, ` +
          `threshold: ${NOTIFY_BEFORE_MS}ms, alreadyNotified: ${notifiedEventIds.has(event.id)}`
        )
      }
    }

    // Clean up old event IDs (events that have already ended)
    for (const id of notifiedEventIds) {
      const event = events.find((e) => e.id === id)
      if (event) {
        const end = new Date(event.endTime).getTime()
        if (end < now) {
          notifiedEventIds.delete(id)
        }
      }
    }
  } catch (err) {
    console.error('[MeetingNotifier] Error checking upcoming meetings:', err)
  }
}

export function startMeetingNotifier(): void {
  stopMeetingNotifier()
  console.log('[MeetingNotifier] Started — polling every 30s, notify 2 min before')
  // Run an initial check immediately
  checkUpcomingMeetings()
  pollInterval = setInterval(checkUpcomingMeetings, POLL_INTERVAL_MS)
}

export function stopMeetingNotifier(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    console.log('[MeetingNotifier] Stopped')
  }
}
