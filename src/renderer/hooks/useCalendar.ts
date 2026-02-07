import { useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CalendarEvent } from '../../shared/types/calendar'

export function useCalendar() {
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const setCalendarEvents = useAppStore((s) => s.setCalendarEvents)
  const setCalendarConnected = useAppStore((s) => s.setCalendarConnected)
  const pollRef = useRef<ReturnType<typeof setInterval>>()

  const fetchEvents = useCallback(async () => {
    try {
      const events = await window.api.invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_EVENTS)
      console.log('[useCalendar] Fetched events:', events.length, events.map((e) => e.title))
      setCalendarEvents(events)
    } catch (err) {
      console.error('Failed to fetch calendar events:', err)
    }
  }, [setCalendarEvents])

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      const result = await window.api.invoke<{ connected: boolean }>(
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
    await window.api.invoke(IPC_CHANNELS.CALENDAR_DISCONNECT)
    setCalendarConnected(false)
    setCalendarEvents([])
  }, [setCalendarConnected, setCalendarEvents])

  // Check connection status from main process on mount
  useEffect(() => {
    async function init() {
      try {
        const connected = await window.api.invoke<boolean>(IPC_CHANNELS.CALENDAR_IS_CONNECTED)
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

  // Poll every 5 minutes
  useEffect(() => {
    if (!calendarConnected) return

    pollRef.current = setInterval(fetchEvents, 5 * 60 * 1000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [calendarConnected, fetchEvents])

  return {
    calendarEvents,
    calendarConnected,
    connect,
    disconnect: disconnectCalendar,
    refresh: fetchEvents
  }
}
