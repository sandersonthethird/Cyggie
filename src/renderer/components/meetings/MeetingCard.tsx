import { useRef, useState } from 'react'
import type { Meeting } from '../../../shared/types/meeting'
import { getSingleCompanyDomain } from '../../../shared/utils/company-domain'
import { formatMeetingDuration, formatMeetingTime } from '../../utils/format'
import { useOutsideClick } from '../../hooks/useOutsideClick'
import styles from './MeetingCard.module.css'

interface MeetingCardProps {
  meeting: Meeting
  snippet?: string
  onClick: () => void
  onDelete: () => void
  onCopyLink: () => void
}

export default function MeetingCard({ meeting, snippet, onClick, onDelete, onCopyLink }: MeetingCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useOutsideClick(menuRef, () => setMenuOpen(false), menuOpen)

  const attendees = meeting.attendees && meeting.attendees.length > 0
    ? meeting.attendees
    : Object.values(meeting.speakerMap)
  const speakerNames = attendees.join(', ')
  const companyDomain = getSingleCompanyDomain(meeting.attendeeEmails)
  const gmailEmail = !companyDomain
    ? (meeting.attendeeEmails ?? []).find((e) => e.toLowerCase().endsWith('@gmail.com')) ?? null
    : null

  return (
    <div className={styles.card} onClick={onClick}>
      {companyDomain ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(companyDomain)}&sz=32`}
          alt=""
          className={styles.logo}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : gmailEmail ? (
        <img
          src={`https://www.google.com/s2/photos/profile/${encodeURIComponent(gmailEmail)}?sz=32`}
          alt=""
          className={styles.profilePic}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : null}
      <div className={styles.row}>
        <h3 className={styles.title}>{meeting.title}</h3>
        <span className={styles.time}>{formatMeetingTime(meeting.date)}</span>
      </div>
      <div className={styles.row}>
        {speakerNames ? (
          <span className={styles.speakers}>{speakerNames}</span>
        ) : (
          <span />
        )}
        <span className={styles.duration}>{formatMeetingDuration(meeting.durationSeconds)}</span>
      </div>
      {snippet && (
        <div className={styles.row}>
          <p className={styles.snippet} dangerouslySetInnerHTML={{ __html: snippet }} />
          <span />
        </div>
      )}
      <div className={styles.menuWrapper} ref={menuRef}>
        <button
          className={styles.menuBtn}
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((prev) => !prev)
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className={styles.menu}>
            <button
              className={styles.menuItem}
              onClick={(e) => {
                e.stopPropagation()
                onCopyLink()
                setMenuOpen(false)
              }}
            >
              Copy link
            </button>
            <button
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
                setMenuOpen(false)
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
