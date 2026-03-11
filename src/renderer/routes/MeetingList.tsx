import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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

type VirtualRow =
  | { type: 'header'; heading: string }
  | { type: 'item'; item: DisplayItem }

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const bulkMenuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!bulkMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target as Node)) {
        setBulkMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [bulkMenuOpen])

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0 || bulkDeleting) return
    setBulkMenuOpen(false)
    setBulkDeleting(true)
    for (const id of selectedIds) {
      deleteMeeting(id)
    }
    setSelectedIds(new Set())
    setBulkDeleting(false)
  }, [selectedIds, bulkDeleting, deleteMeeting])

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
  const pastMeetings = meetings.filter((m) => m.status === 'recording' || m.status === 'transcribed' || m.status === 'summarized')

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

  // Flatten grouped items into a virtual-friendly list of headers + meeting rows
  const virtualRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = []
    for (const [heading, items] of groupByDate(displayItems)) {
      rows.push({ type: 'header', heading })
      for (const item of items) {
        rows.push({ type: 'item', item })
      }
    }
    return rows
  }, [displayItems])

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => virtualRows[i]?.type === 'header' ? 30 : 52,
    overscan: 5
  })

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
      <div className={styles.scrollArea} ref={scrollRef}>
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
          {!hasSearch && (
            <h3 className={styles.sectionHeader}>Recent Meetings</h3>
          )}
          <div className={styles.virtualList} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vrow) => {
              const row = virtualRows[vrow.index]
              if (row.type === 'header') {
                return (
                  <div
                    key={`h-${row.heading}`}
                    style={{ position: 'absolute', top: vrow.start, left: 0, right: 0 }}
                    className={styles.dateHeader}
                  >
                    <span>{row.heading}</span>
                  </div>
                )
              }
              const { id, meeting, snippet } = row.item
              if (!meeting) return null
              return (
                <div
                  key={id}
                  style={{ position: 'absolute', top: vrow.start, left: 0, right: 0 }}
                  className={`${styles.cardWrapper} ${selectedIds.has(id) ? styles.cardWrapperSelected : ''}`}
                >
                  <div
                    className={styles.checkboxZone}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }}
                  >
                    <input
                      type="checkbox"
                      className={styles.meetingCheckbox}
                      checked={selectedIds.has(id)}
                      onChange={() => {}}
                      tabIndex={-1}
                    />
                  </div>
                  <MeetingCard
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
                </div>
              )
            })}
          </div>
        </div>
      )}

      {hasSearch && !isSearching && searchResults.length === 0 && (
        <p className={styles.noResults}>No meetings match your search.</p>
      )}
      </div>

      {selectedIds.size > 0 && (
        <div className={styles.bulkBar}>
          <button
            className={styles.bulkClear}
            onClick={() => setSelectedIds(new Set())}
            aria-label="Clear selection"
          >
            {selectedIds.size} selected ✕
          </button>
          <div className={styles.bulkMenuWrap} ref={bulkMenuRef}>
            <button
              className={styles.bulkMenuBtn}
              onClick={() => setBulkMenuOpen((v) => !v)}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Working…' : 'Actions ▾'}
            </button>
            {bulkMenuOpen && (
              <div className={styles.bulkMenu}>
                <button
                  className={`${styles.bulkMenuItem} ${styles.bulkMenuItemDanger}`}
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                >
                  Delete {selectedIds.size} meeting{selectedIds.size !== 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
