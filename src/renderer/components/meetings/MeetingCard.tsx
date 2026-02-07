import { useEffect, useRef, useState } from 'react'
import type { Meeting } from '../../../shared/types/meeting'
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

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.header}>
        <h3 className={styles.title}>{meeting.title}</h3>
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
      <div className={styles.meta}>
        <span>{formatDate(meeting.date)}</span>
        <span>{formatDuration(meeting.durationSeconds)}</span>
        {meeting.meetingPlatform && <span className={styles.platform}>{meeting.meetingPlatform}</span>}
        <span>{meeting.speakerCount} speaker{meeting.speakerCount !== 1 ? 's' : ''}</span>
      </div>
      {snippet && (
        <p className={styles.snippet} dangerouslySetInnerHTML={{ __html: snippet }} />
      )}
    </div>
  )
}
