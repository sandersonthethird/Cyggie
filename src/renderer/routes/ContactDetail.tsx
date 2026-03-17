import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ContactDetail as ContactDetailType, ContactMeetingRef } from '../../shared/types/contact'
import type { ContactSummaryUpdateProposal } from '../../shared/types/summary'
import type { CalendarEvent } from '../../shared/types/calendar'
import { ContactPropertiesPanel } from '../components/contact/ContactPropertiesPanel'
import { ContactMeetings } from '../components/contact/ContactMeetings'
import { ContactEmails } from '../components/contact/ContactEmails'
import { ContactNotes } from '../components/contact/ContactNotes'
import { ContactTimeline } from '../components/contact/ContactTimeline'
import ChatInterface from '../components/chat/ChatInterface'
import { usePanelResize } from '../hooks/usePanelResize'
import styles from './ContactDetail.module.css'

/**
 * Merge proposals from multiple meetings for the same contact.
 * For each field, keep the first non-null value (most recent meeting first,
 * since summarizedMeetings is sorted date-desc before calling).
 */
function mergeContactProposals(proposals: ContactSummaryUpdateProposal[]): ContactSummaryUpdateProposal[] {
  const byContact = new Map<string, ContactSummaryUpdateProposal>()
  for (const p of proposals) {
    const existing = byContact.get(p.contactId)
    if (!existing) {
      byContact.set(p.contactId, { ...p, changes: [...p.changes], updates: { ...p.updates } })
      continue
    }
    // Merge: keep first non-null per field
    for (const change of p.changes) {
      if (!existing.changes.some((c) => c.field === change.field)) {
        existing.changes.push(change)
        if (change.field === 'title' && !existing.updates.title) existing.updates.title = change.to
        if (change.field === 'phone' && !existing.updates.phone) existing.updates.phone = change.to
        if (change.field === 'linkedinUrl' && !existing.updates.linkedinUrl) existing.updates.linkedinUrl = change.to
      }
    }
    if (!existing.companyLink && p.companyLink) {
      existing.companyLink = p.companyLink
      if (!existing.changes.some((c) => c.field === 'company')) {
        existing.changes.push({ field: 'company', from: null, to: p.companyLink.companyName })
      }
    }
    // Merge fieldSources: latest meeting wins per field (already handled by service)
    if (p.updates.fieldSources) existing.updates.fieldSources = p.updates.fieldSources
  }
  return [...byContact.values()]
}

type ContactTab = 'timeline' | 'meetings' | 'emails' | 'notes'

export default function ContactDetail() {
  const { contactId: id } = useParams<{ contactId: string }>()
  const [contact, setContact] = useState<ContactDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [activeTab, setActiveTab] = useState<ContactTab>('timeline')
  const { leftWidth, dividerProps } = usePanelResize()
  const [contactEnrichProposals, setContactEnrichProposals] = useState<ContactSummaryUpdateProposal[]>([])
  const [contactEnrichDialogOpen, setContactEnrichDialogOpen] = useState(false)
  const [contactEnrichSelections, setContactEnrichSelections] = useState<Record<string, boolean>>({})
  const [isApplyingEnrich, setIsApplyingEnrich] = useState(false)
  const [isLoadingEnrich, setIsLoadingEnrich] = useState(false)
  const [enrichSuccessMsg, setEnrichSuccessMsg] = useState<string | null>(null)

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

  const summarizedMeetings = useMemo(
    () => contact?.meetings.filter((m) => m.status === 'summarized') ?? [],
    [contact]
  )

  const showEnrichBanner = useMemo(
    () =>
      !contact?.title &&
      !contact?.phone &&
      !contact?.linkedinUrl &&
      summarizedMeetings.length > 0,
    [contact, summarizedMeetings]
  )

  const parsedFieldSources = useMemo((): Record<string, { meetingId: string; meetingTitle: string }> => {
    if (!contact?.fieldSources) return {}
    try {
      const raw = JSON.parse(contact.fieldSources) as Record<string, string>
      // raw is { field: meetingId }; we look up meeting title from contact.meetings
      const result: Record<string, { meetingId: string; meetingTitle: string }> = {}
      for (const [field, meetingId] of Object.entries(raw)) {
        const m = contact.meetings.find((mt) => mt.id === meetingId)
        result[field] = { meetingId, meetingTitle: m?.title ?? 'a meeting' }
      }
      return result
    } catch {
      return {}
    }
  }, [contact])

  const handleEnrichFromMeetings = useCallback(async () => {
    if (summarizedMeetings.length === 0) return
    setIsLoadingEnrich(true)
    try {
      const allResults = await Promise.all(
        summarizedMeetings.map((m) =>
          window.api.invoke<ContactSummaryUpdateProposal[]>(IPC_CHANNELS.CONTACT_ENRICH_FROM_MEETING, m.id)
        )
      )
      const merged = mergeContactProposals(allResults.flat())
      if (merged.length > 0) {
        const selections: Record<string, boolean> = {}
        for (const p of merged) selections[p.contactId] = true
        setContactEnrichSelections(selections)
        setContactEnrichProposals(merged)
        setContactEnrichDialogOpen(true)
      }
    } catch (err) {
      console.error('[ContactDetail] Failed to load enrichment proposals:', err)
    } finally {
      setIsLoadingEnrich(false)
    }
  }, [summarizedMeetings])

  const handleApplyEnrich = useCallback(async () => {
    const accepted = contactEnrichProposals.filter(
      (p) => contactEnrichSelections[p.contactId] !== false
    )
    setContactEnrichDialogOpen(false)
    setContactEnrichProposals([])
    if (accepted.length === 0) return
    setIsApplyingEnrich(true)
    try {
      const names: string[] = []
      for (const p of accepted) {
        const fieldUpdates = { ...p.updates }
        if (Object.keys(fieldUpdates).length > 0) {
          await window.api.invoke(IPC_CHANNELS.CONTACT_UPDATE, p.contactId, fieldUpdates)
        }
        if (p.companyLink) {
          await window.api.invoke(IPC_CHANNELS.CONTACT_SET_COMPANY, p.contactId, p.companyLink.companyName)
        }
        names.push(p.contactName)
      }
      // Re-fetch contact to show updated values
      if (id) {
        const updated = await window.api.invoke<ContactDetailType>(IPC_CHANNELS.CONTACT_GET, id)
        if (updated) setContact(updated)
      }
      setEnrichSuccessMsg(`${names.join(', ')} updated`)
      setTimeout(() => setEnrichSuccessMsg(null), 3000)
    } catch (err) {
      console.error('[ContactDetail] Failed to apply contact updates:', err)
    } finally {
      setIsApplyingEnrich(false)
    }
  }, [contactEnrichProposals, contactEnrichSelections, id])

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
          showEnrichBanner={showEnrichBanner}
          enrichMeetingCount={summarizedMeetings.length}
          fieldSources={parsedFieldSources}
          onEnrichFromMeetings={() => void handleEnrichFromMeetings()}
          isLoadingEnrich={isLoadingEnrich}
        />
        {enrichSuccessMsg && (
          <div className={styles.enrichSuccess}>
            ✓ {enrichSuccessMsg}
          </div>
        )}
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
            hasEmail={!!contact.email}
            className={activeTab !== 'timeline' ? styles.hidden : ''}
          />
          <ContactMeetings
            meetings={mergedMeetings}
            className={activeTab !== 'meetings' ? styles.hidden : ''}
          />
          <ContactEmails
            contactId={contact.id}
            hasEmail={!!contact.email}
            className={activeTab !== 'emails' ? styles.hidden : ''}
          />
          <ContactNotes
            contactId={contact.id}
            className={activeTab !== 'notes' ? styles.hidden : ''}
          />
        </div>
      </div>

      {contactEnrichDialogOpen && createPortal(
        <div className={styles.enrichOverlay}>
          <div className={styles.enrichDialog}>
            <h3 className={styles.enrichDialogTitle}>
              Enrich contact profile
            </h3>
            <p className={styles.enrichDialogSubtitle}>
              New information was found in meeting summaries. Select which updates to apply.
            </p>
            <div className={styles.enrichProposalList}>
              {contactEnrichProposals.map((proposal) => (
                <div key={proposal.contactId} className={styles.enrichProposal}>
                  <div className={styles.enrichProposalName}>
                    <input
                      type="checkbox"
                      checked={contactEnrichSelections[proposal.contactId] !== false}
                      onChange={() => {
                        setContactEnrichSelections((prev) => ({
                          ...prev,
                          [proposal.contactId]: prev[proposal.contactId] === false
                        }))
                      }}
                    />
                    <strong>{proposal.contactName}</strong>
                  </div>
                  <div className={styles.enrichProposalChanges}>
                    {proposal.changes.map((change) => (
                      <div key={change.field} className={styles.enrichChange}>
                        <span className={styles.enrichChangeField}>{change.field}:</span>
                        <span className={styles.enrichChangeFrom}>{change.from || '(empty)'}</span>
                        <span>→</span>
                        <span className={styles.enrichChangeTo}>{change.to}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.enrichDialogActions}>
              <button
                className={styles.enrichDialogSkip}
                onClick={() => {
                  setContactEnrichDialogOpen(false)
                  setContactEnrichProposals([])
                }}
                disabled={isApplyingEnrich}
              >
                Skip
              </button>
              <button
                className={styles.enrichDialogApply}
                onClick={() => void handleApplyEnrich()}
                disabled={isApplyingEnrich || Object.values(contactEnrichSelections).every((v) => v === false)}
              >
                {isApplyingEnrich ? 'Applying…' : `Apply ${Object.values(contactEnrichSelections).filter((v) => v !== false).length} update${Object.values(contactEnrichSelections).filter((v) => v !== false).length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
