import { useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CalendarEvent } from '../../shared/types/calendar'
import { api } from '../api'
import { ipcCache } from '../api/ipcCache'

const CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000

export function useCalendar() {
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const setCalendarEvents = useAppStore((s) => s.setCalendarEvents)
  const setCalendarConnected = useAppStore((s) => s.setCalendarConnected)
  const pollRef = useRef<ReturnType<typeof setInterval>>()

  // Normal fetch — hits the in-session ipcCache (5-min TTL) so re-mounts and
  // multiple consumers don't re-invoke. The main-process persistent cache
  // covers cross-restart. `refresh` below bypasses both layers.
  const fetchEvents = useCallback(async () => {
    try {
      const events = await ipcCache.get<CalendarEvent[]>(
        IPC_CHANNELS.CALENDAR_EVENTS,
        null,
        () => api.invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_EVENTS),
        { ttlMs: CALENDAR_CACHE_TTL_MS },
      )
      console.log('[useCalendar] Fetched events:', events.length, events.map((e) => e.title))
      setCalendarEvents(events)
    } catch (err) {
      console.error('Failed to fetch calendar events:', err)
    }
  }, [setCalendarEvents])

  // Manual / polling refresh — bypasses both cache layers. CALENDAR_REFRESH
  // is in MUTATION_INVALIDATIONS, so the api wrapper auto-clears the
  // renderer-side cache for CALENDAR_EVENTS as soon as this call resolves.
  const refreshEvents = useCallback(async () => {
    try {
      const events = await api.invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_REFRESH)
      setCalendarEvents(events)
    } catch (err) {
      console.error('Failed to refresh calendar events:', err)
    }
  }, [setCalendarEvents])

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      const result = await api.invoke<{ connected: boolean }>(
        IPC_CHANNELS.CALENDAR_CONNECT,
        clientId,
        clientSecret
      )
      setCalendarConnected(result.connected)
      if (result.connected) {
        await fetchEvents()
      }
    },
    [setCalendarConnected, fetchEvents]
  )

  const disconnectCalendar = useCallback(async () => {
    await api.invoke(IPC_CHANNELS.CALENDAR_DISCONNECT)
    setCalendarConnected(false)
    setCalendarEvents([])
  }, [setCalendarConnected, setCalendarEvents])

  // Check connection status from main process on mount
  useEffect(() => {
    async function init() {
      try {
        const connected = await api.invoke<boolean>(IPC_CHANNELS.CALENDAR_IS_CONNECTED)
        console.log('[useCalendar] Connection status from main:', connected)
        if (connected) {
          setCalendarConnected(true)
          await fetchEvents()
        }
      } catch (err) {
        console.error('Failed to check calendar connection:', err)
      }
    }
    init()
  }, [setCalendarConnected, fetchEvents])

  // Poll every 5 minutes — uses refreshEvents so the cache doesn't just hit
  // and produce stale data forever (both cache TTLs are 5 min in-session).
  useEffect(() => {
    if (!calendarConnected) return

    pollRef.current = setInterval(refreshEvents, 5 * 60 * 1000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [calendarConnected, refreshEvents])

  return {
    calendarEvents,
    calendarConnected,
    connect,
    disconnect: disconnectCalendar,
    refresh: refreshEvents,
  }
}
