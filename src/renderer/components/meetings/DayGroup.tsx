import { useMemo } from 'react'
import type { Meeting } from '../../../shared/types/meeting'
import { MeetingRow } from './MeetingRow'
import { NowLine } from './NowLine'
import styles from './DayGroup.module.css'

const DAY_ABBREVS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface DayGroupProps {
  dateKey: string  // YYYY-MM-DD
  meetings: Meeting[]
  selectedId?: string | null
  onSelect: (id: string) => void
}

export function DayGroup({ dateKey, meetings, selectedId, onSelect }: DayGroupProps) {
  const now = useMemo(() => new Date(), [])

  const date = useMemo(() => {
    const [y, m, d] = dateKey.split('-').map(Number)
    return new Date(y, m - 1, d)
  }, [dateKey])

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = date.getTime() === today.getTime()
  const isTomorrow = date.getTime() === tomorrow.getTime()

  // Build kicker text
  const dayAbbrev = DAY_ABBREVS[date.getDay()]
  let kicker: string
  if (isToday) kicker = `TODAY · ${dayAbbrev}`
  else if (isTomorrow) kicker = `TOMORROW · ${dayAbbrev}`
  else kicker = dayAbbrev

  const dayNumber = date.getDate()
  const monthName = MONTH_NAMES[date.getMonth()]
  const meetingCount = meetings.length
  const countLabel = meetingCount === 1 ? '1 meeting' : `${meetingCount} meetings`

  // Find NowLine insertion index (for today's group only)
  const nowLineIndex = useMemo(() => {
    if (!isToday) return -1
    const nowMs = now.getTime()
    const idx = meetings.findIndex(m => new Date(m.date).getTime() > nowMs)
    return idx === -1 ? meetings.length : idx
  }, [isToday, meetings, now])

  return (
    <div className={styles.group}>
      {/* Day label (left column) */}
      <div className={styles.dayLabel}>
        <div className={styles.kicker}>{kicker}</div>
        <div className={styles.dayNumber}>{dayNumber}</div>
        <div className={styles.month}>{monthName}</div>
        <div className={styles.count}>{countLabel}</div>
      </div>

      {/* Meeting rows + NowLine (right column) */}
      <div className={styles.meetings}>
        {meetings.map((meeting, i) => (
          <div key={meeting.id}>
            {i === nowLineIndex && <NowLine />}
            <MeetingRow
              meeting={meeting}
              selected={meeting.id === selectedId}
              onClick={() => onSelect(meeting.id)}
            />
          </div>
        ))}
        {nowLineIndex === meetings.length && <NowLine />}
      </div>
    </div>
  )
}
