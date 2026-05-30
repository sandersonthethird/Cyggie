import { useMemo } from 'react'
import { Users } from 'lucide-react'
import type { Meeting } from '../../../shared/types/meeting'
import { StagePill } from '../crm/StagePill'
import { formatMeetingDuration, formatMeetingTime } from '../../utils/format'
import { dedupAttendeesByName } from '../../utils/attendees'
import { isLive as checkIsLive } from '../../hooks/useMeetings'
import styles from './MeetingRow.module.css'

// ── Avatar color palette ────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E',
  '#F97316', '#EAB308', '#22C55E', '#0EA5E9',
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?'
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function getAvatarColor(name: string): string {
  return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length]
}

// ── Status icons (inline SVG) ───────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 2L10 6L3 10V2Z" fill="currentColor" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 1h4l3 3v6a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4 7h4M4 9h2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 3.5V6L7.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function VideoOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="3" width="7" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5l3-1.5v5L8 7" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

interface MeetingRowProps {
  meeting: Meeting
  selected?: boolean
  onClick: () => void
}

export function MeetingRow({ meeting, selected, onClick }: MeetingRowProps) {
  const now = useMemo(() => new Date(), [])
  const live = checkIsLive(meeting, now)
  const isPast = new Date(meeting.date).getTime() + (meeting.durationSeconds ?? 0) * 1000 < now.getTime()

  const rawAttendees = meeting.attendees?.length
    ? meeting.attendees
    : Object.values(meeting.speakerMap)
  const attendees = dedupAttendeesByName(rawAttendees, meeting.attendeeEmails ?? undefined).map((r) => r.name)
  const participantCount = attendees.length
  const visibleAvatars = attendees.slice(0, 3)
  const overflowCount = Math.max(0, attendees.length - 3)

  const hasRecording = meeting.recordingPath !== null
  const hasSummary = meeting.summaryPath !== null
  const isProcessing = meeting.status === 'recording'

  const rowClasses = [
    styles.row,
    live ? styles.rowLive : '',
    isPast && !live ? styles.rowPast : '',
    selected ? styles.rowSelected : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rowClasses} onClick={onClick} role="button" tabIndex={0}>
      {/* Time cell */}
      <div className={styles.timeCell}>
        <span className={styles.startTime}>{formatMeetingTime(meeting.date)}</span>
        <span className={styles.duration}>{formatMeetingDuration(meeting.durationSeconds)}</span>
      </div>

      {/* Info cell */}
      <div className={styles.infoCell}>
        <div className={styles.titleRow}>
          <span className={styles.title}>{meeting.title}</span>
          {live && (
            <span className={styles.livePill}>
              <span className={styles.liveDot} />
              LIVE
            </span>
          )}
        </div>

        <div className={styles.metaRow}>
          {meeting.company && (
            <>
              <span className={styles.companyChip}>
                {meeting.company.domain ? (
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(meeting.company.domain)}&sz=16`}
                    alt=""
                    className={styles.companyLogo}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <span className={styles.companyLogoPlaceholder} />
                )}
                <span className={styles.companyName}>{meeting.company.name}</span>
              </span>
              {meeting.company.stage && (
                <>
                  <span className={styles.dotSep} />
                  <StagePill stage={meeting.company.stage} />
                </>
              )}
              {participantCount > 0 && <span className={styles.dotSep} />}
            </>
          )}

          {participantCount > 0 && (
            <span className={styles.participants}>
              <Users size={12} className={styles.participantIcon} />
              {participantCount}
            </span>
          )}
        </div>
      </div>

      {/* Right cell */}
      <div className={styles.rightCell}>
        {/* Avatar stack (rendered in reverse for CSS overlap) */}
        {visibleAvatars.length > 0 && (
          <div className={styles.avatarStack}>
            {overflowCount > 0 && (
              <span className={styles.avatarOverflow}>+{overflowCount}</span>
            )}
            {[...visibleAvatars].reverse().map((name, i) => (
              <span
                key={i}
                className={styles.avatar}
                style={{ background: getAvatarColor(name) }}
                title={name}
              >
                {getInitials(name)}
              </span>
            ))}
          </div>
        )}

        {/* Status icons */}
        <div className={styles.statusIcons}>
          {isProcessing ? (
            <span className={`${styles.statusIcon} ${styles.statusProcessing}`} title="Processing">
              <ClockIcon />
            </span>
          ) : (
            <>
              {hasRecording && (
                <span className={`${styles.statusIcon} ${styles.statusRecording}`} title="Recording available">
                  <PlayIcon />
                </span>
              )}
              {hasSummary && (
                <span className={`${styles.statusIcon} ${styles.statusSummary}`} title="AI summary ready">
                  <DocIcon />
                </span>
              )}
              {!hasRecording && !hasSummary && (
                <span className={`${styles.statusIcon} ${styles.statusNone}`} title="No recording">
                  <VideoOffIcon />
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
