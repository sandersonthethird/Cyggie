import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  authorize,
  authorizeDriveFiles,
  disconnect,
  isCalendarConnected,
  storeGoogleClientCredentials,
  getCalendarAccountEmail,
  getGmailAccountEmail
} from '../calendar/google-auth'
import {
  getUpcomingEvents,
  getEventsAround,
  getEventsInRange,
  getCurrentMeetingEvent
} from '../calendar/google-calendar'
import {
  startMeetingNotifier,
  stopMeetingNotifier,
  triggerImmediateCheck
} from '../calendar/meeting-notifier'
import { enrichDomainsFromCalendarEvents } from '../services/company-enrichment'
import { persistentCache } from '../cache/persistent-cache'
import { prepareMeetingFromCalendarEvent } from './meeting.ipc'
import { getCurrentUserId } from '../security/current-user'
import type { CalendarEvent } from '../../shared/types/calendar'

let pollingInterval: ReturnType<typeof setInterval> | null = null

const CALENDAR_LOOKAHEAD_HOURS = 720
const CALENDAR_LOOKBACK_HOURS = 24
const CALENDAR_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export function calendarCacheKey(): string {
  // Scope cache by user so multi-account doesn't serve cross-account data.
  // Anonymous fallback when no account is connected — those calls fail
  // upstream anyway, so the key doesn't matter much.
  const email = getCalendarAccountEmail() ?? 'anonymous'
  return `calendar-events-${email}-${CALENDAR_LOOKAHEAD_HOURS}`
}

/**
 * Reconcile past calendar events into the meetings table. Idempotent via
 * `findMeetingByCalendarEventId` inside the helper — re-running on the same
 * set is a cheap pile of indexed reads. See "i had a meeting" plan.
 */
function reconcilePastEvents(events: CalendarEvent[]): void {
  const userId = getCurrentUserId()
  const now = Date.now()
  for (const ev of events) {
    if (new Date(ev.startTime).getTime() >= now) continue
    try {
      prepareMeetingFromCalendarEvent(
        {
          id: ev.id,
          title: ev.title,
          startTime: ev.startTime,
          platform: ev.platform,
          meetingUrl: ev.meetingUrl,
          attendees: ev.attendees,
          attendeeEmails: ev.attendeeEmails,
        },
        userId,
      )
    } catch (err) {
      console.error(
        `[CalendarReconcile] persist failed eventId=${ev.id} metric=meeting.reconcile.failed count=1`,
        err,
      )
    }
  }
}

export async function fetchAndEnrichCalendarEvents(): Promise<CalendarEvent[]> {
  const events = await getEventsAround(CALENDAR_LOOKBACK_HOURS, CALENDAR_LOOKAHEAD_HOURS)
  reconcilePastEvents(events)
  enrichDomainsFromCalendarEvents(events).catch((err) =>
    console.error('[Company Enrichment] Calendar events enrichment failed:', err)
  )
  triggerImmediateCheck()
  // Return future-only slice so the Upcoming UI and downstream callers
  // don't suddenly see past events.
  const nowMs = Date.now()
  return events.filter((e) => new Date(e.startTime).getTime() >= nowMs)
}

export function registerCalendarHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CALENDAR_CONNECT,
    async (_event, clientId: string, clientSecret: string) => {
      // Store credentials first
      storeGoogleClientCredentials(clientId, clientSecret)
      // Run OAuth flow
      await authorize()
      // Start polling
      startPolling()
      return { connected: true }
    }
  )

  ipcMain.handle(IPC_CHANNELS.CALENDAR_DISCONNECT, () => {
    disconnect()
    stopPolling()
    return { connected: false }
  })

  // Disk-backed cache so cold-start app launches don't pay the 1.5–2s
  // Google API latency. CALENDAR_REFRESH below bypasses the cache when the
  // renderer wants a guaranteed-fresh read.
  ipcMain.handle(IPC_CHANNELS.CALENDAR_EVENTS, async () => {
    return persistentCache.get(calendarCacheKey(), CALENDAR_CACHE_TTL_MS, fetchAndEnrichCalendarEvents)
  })

  ipcMain.handle(IPC_CHANNELS.CALENDAR_REFRESH, async () => {
    persistentCache.invalidate(calendarCacheKey())
    return fetchAndEnrichCalendarEvents()
  })

  ipcMain.handle(
    IPC_CHANNELS.CALENDAR_EVENTS_RANGE,
    async (_event, rangeStart: string, rangeEnd: string) => {
      return getEventsInRange(rangeStart, rangeEnd)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CALENDAR_SYNC, async () => {
    // CALENDAR_SYNC is an explicit user-initiated refresh — bypass cache.
    persistentCache.invalidate(calendarCacheKey())
    return fetchAndEnrichCalendarEvents()
  })

  ipcMain.handle(IPC_CHANNELS.CALENDAR_REAUTHORIZE, async (_event, target?: 'calendar' | 'drive-files') => {
    if (target === 'drive-files') {
      await authorizeDriveFiles()
      return { connected: true }
    }

    await authorize()
    return { connected: true }
  })

  ipcMain.handle(IPC_CHANNELS.CALENDAR_IS_CONNECTED, () => {
    return isCalendarConnected()
  })

  ipcMain.handle(IPC_CHANNELS.GOOGLE_ACCOUNT_EMAILS, () => ({
    calendarEmail: getCalendarAccountEmail(),
    gmailEmail: getGmailAccountEmail()
  }))

  // Check if already connected on startup and begin polling
  const connected = isCalendarConnected()
  console.log('[Calendar] Startup check — isCalendarConnected:', connected)
  if (connected) {
    startPolling()
  }
}

function startPolling(): void {
  stopPolling()
  // Poll every 5 minutes for renderer event list
  pollingInterval = setInterval(async () => {
    if (isCalendarConnected()) {
      // Events are fetched on-demand via IPC
    }
  }, 5 * 60 * 1000)

  // Start the meeting notifier (polls every 30s for 1-minute-before alerts)
  startMeetingNotifier()
}

function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
  stopMeetingNotifier()
}

export { getCurrentMeetingEvent }
