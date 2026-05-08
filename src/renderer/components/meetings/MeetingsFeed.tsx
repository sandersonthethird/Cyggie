import { useRef, useCallback, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Meeting } from '../../../shared/types/meeting'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import { FeedTopBar } from './FeedTopBar'
import { DayGroup } from './DayGroup'
import { MeetingsCalendar } from './MeetingsCalendar'
import styles from './MeetingsFeed.module.css'

interface MeetingsFeedProps {
  groupedMeetings: [string, Meeting[]][]
  filtered: Meeting[]
}

export function MeetingsFeed({ groupedMeetings, filtered }: MeetingsFeedProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchQuery = searchParams.get('q') ?? ''
  const activeView = searchParams.get('view') === 'calendar' ? 'calendar' : 'timeline'

  const handleSelect = useCallback(async (id: string) => {
    if (id.startsWith('cal-')) {
      // Synthetic row from a calendar event with no meeting record yet.
      // Materialize via MEETING_PREPARE so we have a real id to route to.
      const m = filtered.find(x => x.id === id)
      if (!m || !m.calendarEventId) return
      try {
        const meeting = await api.invoke<Meeting>(
          IPC_CHANNELS.MEETING_PREPARE,
          m.calendarEventId,
          m.title,
          m.date,
          m.meetingPlatform || undefined,
          m.meetingUrl || undefined,
          m.attendees || undefined,
          m.attendeeEmails || undefined,
        )
        navigate(`/meeting/${meeting.id}`)
      } catch (err) {
        console.error('Failed to open calendar meeting:', err)
      }
      return
    }
    navigate(`/meeting/${id}`)
  }, [navigate, filtered])

  // Keyboard navigation (timeline view only)
  const flatIds = filtered.map(m => m.id)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return

    if (e.key === '/') {
      e.preventDefault()
      searchRef.current?.focus()
      return
    }

    if (activeView !== 'timeline') return

    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault()
      const currentIdx = selectedId ? flatIds.indexOf(selectedId) : -1
      let nextIdx: number
      if (e.key === 'j') nextIdx = Math.min(currentIdx + 1, flatIds.length - 1)
      else nextIdx = Math.max(currentIdx - 1, 0)
      if (flatIds[nextIdx]) setSelectedId(flatIds[nextIdx])
      return
    }

    if (e.key === 'Enter' && selectedId) {
      void handleSelect(selectedId)
    }
  }, [selectedId, flatIds, handleSelect, activeView])

  return (
    <div className={styles.container} onKeyDown={handleKeyDown} tabIndex={-1}>
      <FeedTopBar searchRef={searchRef} />

      {activeView === 'calendar' ? (
        <div className={styles.scrollArea}>
          <MeetingsCalendar meetings={filtered} />
        </div>
      ) : (
        <div className={styles.scrollArea}>
          {groupedMeetings.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>No meetings found</div>
              <div className={styles.emptyDesc}>
                {searchQuery ? 'Try adjusting your search or filters.' : 'No meetings match the current filter.'}
              </div>
            </div>
          ) : (
            groupedMeetings.map(([dateKey, meetings]) => (
              <DayGroup
                key={dateKey}
                dateKey={dateKey}
                meetings={meetings}
                selectedId={selectedId}
                onSelect={handleSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
