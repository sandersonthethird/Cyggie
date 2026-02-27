import { useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../shared/types/meeting'
import { getSingleCompanyDomain } from '../../../shared/utils/company-domain'
import styles from './MeetingCard.module.css'

interface MeetingCardProps {
  meeting: Meeting
  snippet?: string
  onClick: () => void
  onDelete: () => void
  onCopyLink: () => void
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m`
  }
  return `${m}m ${s}s`
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

export default function MeetingCard({ meeting, snippet, onClick, onDelete, onCopyLink }: MeetingCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const attendees = meeting.attendees && meeting.attendees.length > 0
    ? meeting.attendees
    : Object.values(meeting.speakerMap)
  const speakerNames = attendees.join(', ')
  const companyDomain = getSingleCompanyDomain(meeting.attendeeEmails)

  return (
    <div className={styles.card} onClick={onClick}>
      {companyDomain && (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(companyDomain)}&sz=32`}
          alt=""
          className={styles.logo}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div className={styles.row}>
        <h3 className={styles.title}>{meeting.title}</h3>
        <span className={styles.time}>{formatTime(meeting.date)}</span>
      </div>
      <div className={styles.row}>
        {speakerNames ? (
          <span className={styles.speakers}>{speakerNames}</span>
        ) : (
          <span />
        )}
        <span className={styles.duration}>{formatDuration(meeting.durationSeconds)}</span>
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
