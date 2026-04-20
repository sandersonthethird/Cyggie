import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/app.store'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CalendarEvent } from '../../shared/types/calendar'
import { api } from '../api'

/**
 * Shared callbacks for MiniCalendar event actions.
 * Used by both Sidebar and TitlebarDateChip to avoid duplicating IPC logic.
 */
export function useMiniCalendarActions() {
  const navigate = useNavigate()
  const dismissEvent = useAppStore((s) => s.dismissEvent)
  const startRecording = useRecordingStore((s) => s.startRecording)

  const handleRecordEvent = useCallback(async (event: CalendarEvent) => {
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        event.title,
        event.id
      )
      startRecording(result.meetingId, result.meetingPlatform)
      navigate(`/meeting/${result.meetingId}`)
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }, [navigate, startRecording])

  const handlePrepareEvent = useCallback(async (event: CalendarEvent) => {
    try {
      const meeting = await api.invoke<{ id: string }>(
        IPC_CHANNELS.MEETING_PREPARE,
        event.id,
        event.title,
        event.startTime,
        event.platform || undefined,
        event.meetingUrl || undefined,
        event.attendees,
        event.attendeeEmails
      )
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to prepare meeting:', err)
    }
  }, [navigate])

  const handleDismissEvent = useCallback((event: CalendarEvent) => {
    dismissEvent(event.id)
  }, [dismissEvent])

  const handleClickMeeting = useCallback((meetingId: string) => {
    navigate(`/meeting/${meetingId}`)
  }, [navigate])

  return { handleRecordEvent, handlePrepareEvent, handleDismissEvent, handleClickMeeting }
}
