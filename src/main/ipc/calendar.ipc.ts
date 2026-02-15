import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  authorize,
  disconnect,
  isCalendarConnected,
  storeGoogleClientCredentials
} from '../calendar/google-auth'
import {
  getUpcomingEvents,
  getEventsInRange,
  getCurrentMeetingEvent
} from '../calendar/google-calendar'
import { startMeetingNotifier, stopMeetingNotifier } from '../calendar/meeting-notifier'
import { enrichDomainsFromCalendarEvents } from '../services/company-enrichment'

let pollingInterval: ReturnType<typeof setInterval> | null = null

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

  ipcMain.handle(IPC_CHANNELS.CALENDAR_EVENTS, async () => {
    const events = await getUpcomingEvents(720)
    enrichDomainsFromCalendarEvents(events).catch((err) =>
      console.error('[Company Enrichment] Calendar events enrichment failed:', err)
    )
    return events
  })

  ipcMain.handle(
    IPC_CHANNELS.CALENDAR_EVENTS_RANGE,
    async (_event, rangeStart: string, rangeEnd: string) => {
      return getEventsInRange(rangeStart, rangeEnd)
    }
  )

  ipcMain.handle(IPC_CHANNELS.CALENDAR_SYNC, async () => {
    const events = await getUpcomingEvents(720)
    enrichDomainsFromCalendarEvents(events).catch((err) =>
      console.error('[Company Enrichment] Calendar sync enrichment failed:', err)
    )
    return events
  })

  ipcMain.handle(IPC_CHANNELS.CALENDAR_REAUTHORIZE, async () => {
    await authorize()
    return { connected: true }
  })

  ipcMain.handle(IPC_CHANNELS.CALENDAR_IS_CONNECTED, () => {
    return isCalendarConnected()
  })

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
