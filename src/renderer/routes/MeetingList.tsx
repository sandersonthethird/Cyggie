import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMeetings } from '../hooks/useMeetings'
import { useSearch } from '../hooks/useSearch'
import { useAppStore } from '../stores/app.store'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import MeetingCard from '../components/meetings/MeetingCard'
import CalendarBadge from '../components/meetings/CalendarBadge'
import EmptyState from '../components/common/EmptyState'
import type { CalendarEvent } from '../../shared/types/calendar'
import type { DriveShareResponse } from '../../shared/types/drive'
import styles from './MeetingList.module.css'

export default function MeetingList() {
  const navigate = useNavigate()
  const { meetings, deleteMeeting } = useMeetings()
  const { searchQuery, searchResults, isSearching } = useSearch()
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const setCalendarEvents = useAppStore((s) => s.setCalendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)
  const startRecording = useRecordingStore((s) => s.startRecording)

  // Filter out dismissed events
  const visibleCalendarEvents = calendarEvents.filter((e) => !dismissedEventIds.has(e.id))

  // Refresh calendar events every time the page is navigated to
  useEffect(() => {
    if (!calendarConnected) return
    window.api
      .invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_EVENTS)
      .then(setCalendarEvents)
      .catch((err) => console.error('Failed to refresh calendar events:', err))
  }, [calendarConnected, setCalendarEvents])

  const handleRecordFromCalendar = async (event: CalendarEvent) => {
    try {
      const result = await window.api.invoke<{ meetingId: string }>(
        IPC_CHANNELS.RECORDING_START,
        event.title,
        event.id
      )
      startRecording(result.meetingId)
      navigate('/recording')
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }

  const handlePrepareFromCalendar = async (event: CalendarEvent) => {
    try {
      const meeting = await window.api.invoke<Meeting>(
        IPC_CHANNELS.MEETING_PREPARE,
        event.id,
        event.title,
        event.startTime,
        event.platform || undefined,
        event.meetingUrl || undefined,
        event.attendees
      )
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to prepare meeting:', err)
    }
  }

  const handleDismissEvent = (event: CalendarEvent) => {
    dismissEvent(event.id)
  }

  const hasSearch = searchQuery.trim().length > 0
  // Only show meetings that have been transcribed or summarized (not scheduled, recording, or error)
  const pastMeetings = meetings.filter((m) => m.status === 'transcribed' || m.status === 'summarized')
  const displayItems = hasSearch
    ? searchResults.map((r) => ({
        id: r.meetingId,
        meeting: meetings.find((m) => m.id === r.meetingId),
        snippet: r.snippet
      }))
    : pastMeetings.map((m) => ({ id: m.id, meeting: m, snippet: undefined }))

  const showUpcoming = calendarConnected && visibleCalendarEvents.length > 0 && !hasSearch

  if (!searchQuery && pastMeetings.length === 0 && !showUpcoming) {
    return (
      <EmptyState
        title="No meetings yet"
        description="Create a note or start recording your first meeting."
        action={{
          label: 'Start Recording',
          onClick: () => navigate('/recording')
        }}
      />
    )
  }

  return (
    <div className={styles.container}>
      {showUpcoming && (
        <div className={styles.section}>
          <h3 className={styles.sectionHeader}>Upcoming</h3>
          <div className={styles.upcomingList}>
            {visibleCalendarEvents.map((event) => (
              <CalendarBadge
                key={event.id}
                event={event}
                onRecord={handleRecordFromCalendar}
                onPrepare={handlePrepareFromCalendar}
                onDismiss={handleDismissEvent}
              />
            ))}
          </div>
        </div>
      )}

      {searchQuery && (
        <p className={styles.resultCount}>
          {isSearching
            ? 'Searching...'
            : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
        </p>
      )}

      {(displayItems.length > 0 || hasSearch) && (
        <div className={styles.section}>
          {!hasSearch && showUpcoming && (
            <h3 className={styles.sectionHeader}>Recent Meetings</h3>
          )}
          <div className={styles.list}>
            {displayItems.map(
              ({ id, meeting, snippet }) =>
                meeting && (
                  <MeetingCard
                    key={id}
                    meeting={meeting}
                    snippet={snippet}
                    onClick={() => navigate(`/meeting/${id}`)}
                    onDelete={() => deleteMeeting(id)}
                    onCopyLink={async () => {
                      try {
                        const result = await window.api.invoke<DriveShareResponse>(
                          IPC_CHANNELS.DRIVE_GET_SHARE_LINK,
                          meeting.id
                        )
                        if (result.success) {
                          await navigator.clipboard.writeText(result.url)
                        } else {
                          alert(result.message)
                        }
                      } catch (err) {
                        console.error('Failed to get Drive link:', err)
                        alert('Failed to get shareable link.')
                      }
                    }}
                  />
                )
            )}
          </div>
        </div>
      )}

      {searchQuery && !isSearching && searchResults.length === 0 && (
        <p className={styles.noResults}>No meetings match your search.</p>
      )}
    </div>
  )
}
