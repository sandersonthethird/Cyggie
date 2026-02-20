import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMeetings } from '../hooks/useMeetings'
import { useSearch } from '../hooks/useSearch'
import { useAppStore } from '../stores/app.store'
import { useRecordingStore } from '../stores/recording.store'
import { useChatStore } from '../stores/chat.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import MeetingCard from '../components/meetings/MeetingCard'
import CalendarBadge from '../components/meetings/CalendarBadge'
import ChatInterface from '../components/chat/ChatInterface'
import EmptyState from '../components/common/EmptyState'
import type { CalendarEvent } from '../../shared/types/calendar'
import type { Meeting } from '../../shared/types/meeting'
import type { DriveShareResponse } from '../../shared/types/drive'
import styles from './MeetingList.module.css'

function formatDateHeading(dateStr: string): string {
  const date = new Date(dateStr)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

interface DisplayItem {
  id: string
  meeting?: Meeting
  snippet?: string
}

function groupByDate(items: DisplayItem[]): [string, DisplayItem[]][] {
  const groups = new Map<string, DisplayItem[]>()
  for (const item of items) {
    if (!item.meeting) continue
    const heading = formatDateHeading(item.meeting.date)
    const group = groups.get(heading)
    if (group) {
      group.push(item)
    } else {
      groups.set(heading, [item])
    }
  }
  return Array.from(groups.entries())
}

function groupCalendarEventsByDate(events: CalendarEvent[]): [string, CalendarEvent[]][] {
  const groups = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const heading = formatDateHeading(event.startTime)
    const group = groups.get(heading)
    if (group) {
      group.push(event)
    } else {
      groups.set(heading, [event])
    }
  }
  return Array.from(groups.entries())
}

export default function MeetingList() {
  const navigate = useNavigate()
  const { meetings, deleteMeeting } = useMeetings()
  const { searchQuery, searchResults, isSearching, hasFilters } = useSearch()
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const setCalendarEvents = useAppStore((s) => s.setCalendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)
  const startRecording = useRecordingStore((s) => s.startRecording)
  const clearConversation = useChatStore((s) => s.clearConversation)
  const [showAllUpcoming, setShowAllUpcoming] = useState(false)

  const UPCOMING_LIMIT = 2

  const hasSearch = searchQuery.trim().length > 0 || hasFilters

  // Filter out dismissed events
  const visibleCalendarEvents = calendarEvents.filter((e) => !dismissedEventIds.has(e.id))
  const upcomingEvents = showAllUpcoming
    ? visibleCalendarEvents
    : visibleCalendarEvents.slice(0, UPCOMING_LIMIT)
  const hasMoreUpcoming = visibleCalendarEvents.length > UPCOMING_LIMIT

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
      const result = await window.api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        event.title,
        event.id
      )
      startRecording(result.meetingId, result.meetingPlatform)
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
        event.attendees,
        event.attendeeEmails
      )
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to prepare meeting:', err)
    }
  }

  const handleDismissEvent = (event: CalendarEvent) => {
    dismissEvent(event.id)
  }

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

  // Clear search chat when results change
  const searchResultIds = useMemo(() => searchResults.map((r) => r.meetingId), [searchResults])
  useEffect(() => {
    clearConversation('search-results')
  }, [searchResultIds, clearConversation])

  if (!searchQuery && !hasFilters && pastMeetings.length === 0 && !showUpcoming) {
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
      <div className={styles.scrollArea}>
      {showUpcoming && (
        <div className={`${styles.section} ${styles.upcoming}`}>
          <h3 className={styles.sectionHeader}>Upcoming</h3>
          {groupCalendarEventsByDate(upcomingEvents).map(([dateHeading, events]) => (
            <div key={dateHeading} className={styles.dateGroup}>
              <div className={styles.dateHeader}>
                <span>{dateHeading}</span>
              </div>
              <div className={styles.list}>
                {events.map((event) => (
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
          ))}
          {hasMoreUpcoming && (
            <button
              className={styles.showMoreBtn}
              onClick={() => setShowAllUpcoming((v) => !v)}
            >
              {showAllUpcoming
                ? 'Show fewer meetings'
                : `Show more meetings (${visibleCalendarEvents.length - UPCOMING_LIMIT} more)`}
            </button>
          )}
        </div>
      )}

      {hasSearch && (
        <p className={styles.resultCount}>
          {isSearching
            ? 'Searching...'
            : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
        </p>
      )}

      {(displayItems.length > 0 || hasSearch) && (
        <div className={`${styles.section} ${styles.recent}`}>
          {!hasSearch && showUpcoming && (
            <h3 className={styles.sectionHeader}>Recent Meetings</h3>
          )}
          {groupByDate(displayItems).map(([dateHeading, items]) => (
            <div key={dateHeading} className={styles.dateGroup}>
              <div className={styles.dateHeader}>
                <span>{dateHeading}</span>
              </div>
              <div className={styles.list}>
                {items.map(
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
          ))}
        </div>
      )}

      {hasSearch && !isSearching && searchResults.length === 0 && (
        <p className={styles.noResults}>No meetings match your search.</p>
      )}
      </div>

      <div className={styles.chatSection}>
        {hasSearch && !isSearching && searchResults.length > 0 ? (
          <ChatInterface meetingIds={searchResultIds} />
        ) : (
          <ChatInterface compact />
        )}
      </div>
    </div>
  )
}
