import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ContactDetail as ContactDetailType, ContactMeetingRef } from '../../shared/types/contact'
import type { CalendarEvent } from '../../shared/types/calendar'
import { ContactPropertiesPanel } from '../components/contact/ContactPropertiesPanel'
import { ContactMeetings } from '../components/contact/ContactMeetings'
import { ContactEmails } from '../components/contact/ContactEmails'
import { ContactNotes } from '../components/contact/ContactNotes'
import { ContactTimeline } from '../components/contact/ContactTimeline'
import ChatInterface from '../components/chat/ChatInterface'
import { usePanelResize } from '../hooks/usePanelResize'
import styles from './ContactDetail.module.css'

type ContactTab = 'timeline' | 'meetings' | 'emails' | 'notes'

export default function ContactDetail() {
  const { contactId: id } = useParams<{ contactId: string }>()
  const [contact, setContact] = useState<ContactDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [activeTab, setActiveTab] = useState<ContactTab>('timeline')
  const { leftWidth, dividerProps } = usePanelResize()

  useEffect(() => {
    if (!id) return
    setLoading(true)
    window.api
      .invoke<ContactDetailType>(IPC_CHANNELS.CONTACT_GET, id)
      .then((data) => setContact(data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id])

  // Fetch past 90 days of calendar events to include in-person/unrecorded meetings
  useEffect(() => {
    if (!contact) return
    const rangeStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const rangeEnd = new Date().toISOString()
    window.api
      .invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_EVENTS_RANGE, rangeStart, rangeEnd)
      .then((events) => setCalendarEvents(Array.isArray(events) ? events : []))
      .catch(() => setCalendarEvents([]))
  }, [contact?.id])

  // Merge DB meetings with calendar events (for in-person/unrecorded meetings)
  const mergedMeetings = useMemo((): ContactMeetingRef[] => {
    if (!contact) return []

    const contactEmails = new Set(
      [...contact.emails, contact.email].filter(Boolean).map((e) => e!.toLowerCase())
    )

    // Convert matching calendar events to ContactMeetingRef format
    const calMeetings: ContactMeetingRef[] = calendarEvents
      .filter((e) => e.attendeeEmails.some((ae) => contactEmails.has(ae.toLowerCase())))
      .map((e) => ({
        id: `cal:${e.id}`,
        title: e.title,
        date: e.startTime,
        status: 'calendar',
        durationSeconds: null
      }))

    // Dedup: skip calendar events already represented by a DB meeting (same day + title)
    const filtered = calMeetings.filter(
      (cal) => !contact.meetings.some(
        (db) =>
          db.date.slice(0, 10) === cal.date.slice(0, 10) &&
          db.title.toLowerCase() === cal.title.toLowerCase()
      )
    )

    return [...contact.meetings, ...filtered].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    )
  }, [contact, calendarEvents])

  // Effective last touchpoint: max of contact's stored value and most recent merged meeting
  const effectiveLastTouchpoint = useMemo(() => {
    if (!contact) return null
    const mostRecentMeeting = mergedMeetings[0]?.date ?? null
    if (!mostRecentMeeting) return contact.lastTouchpoint
    if (!contact.lastTouchpoint) return mostRecentMeeting
    return mostRecentMeeting > contact.lastTouchpoint ? mostRecentMeeting : contact.lastTouchpoint
  }, [contact, mergedMeetings])

  function handleUpdate(updates: Record<string, unknown>) {
    setContact((prev) => prev ? { ...prev, ...updates } : prev)
  }

  if (loading) {
    return <div className={styles.loading}>Loading…</div>
  }
  if (!contact) {
    return <div className={styles.notFound}>Contact not found.</div>
  }

  const totalActivity = (contact.meetingCount || 0) + (contact.emailCount || 0) + (contact.noteCount || 0)
  const tabs: Array<{ key: ContactTab; label: string; badge?: number }> = [
    { key: 'timeline', label: 'Timeline', badge: totalActivity || undefined },
    { key: 'meetings', label: 'Meetings', badge: contact.meetingCount || undefined },
    { key: 'emails', label: 'Emails', badge: contact.emailCount || undefined },
    { key: 'notes', label: 'Notes', badge: contact.noteCount || undefined }
  ]

  return (
    <div className={styles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr` }}>
      {/* Left panel — properties */}
      <div className={styles.leftPanel}>
        <ContactPropertiesPanel
          contact={contact}
          lastTouchpoint={effectiveLastTouchpoint}
          onUpdate={handleUpdate}
        />
      </div>

      <ChatInterface
        floating
        contactId={contact.id}
        entityName={contact.fullName}
        placeholder={`Ask about ${contact.fullName}…`}
      />

      {/* Resizable divider */}
      <div className={styles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={styles.rightPanel}>
        <div className={styles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${styles.tabBtn} ${activeTab === tab.key ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={styles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          <ContactTimeline
            contactId={contact.id}
            className={activeTab !== 'timeline' ? styles.hidden : ''}
          />
          <ContactMeetings
            meetings={mergedMeetings}
            className={activeTab !== 'meetings' ? styles.hidden : ''}
          />
          <ContactEmails
            contactId={contact.id}
            className={activeTab !== 'emails' ? styles.hidden : ''}
          />
          <ContactNotes
            contactId={contact.id}
            className={activeTab !== 'notes' ? styles.hidden : ''}
          />
        </div>
      </div>
    </div>
  )
}
