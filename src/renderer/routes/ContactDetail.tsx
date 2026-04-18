import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { ContactDetail as ContactDetailType, ContactMeetingRef } from '../../shared/types/contact'
import type { ContactSummaryUpdateProposal } from '../../shared/types/summary'
import type { SetCustomFieldValueInput } from '../../shared/types/custom-fields'
import type { CalendarEvent } from '../../shared/types/calendar'
import { contactEnrichedAtKey } from '../../shared/utils/enrichment-keys'
import { ContactPropertiesPanel } from '../components/contact/ContactPropertiesPanel'
import NewCompanyModal from '../components/company/NewCompanyModal'
import { ContactMeetings } from '../components/contact/ContactMeetings'
import { ContactEmails } from '../components/contact/ContactEmails'
import { ContactNotes } from '../components/contact/ContactNotes'
import { ContactTimeline } from '../components/contact/ContactTimeline'
import { ContactDecisions } from '../components/contact/ContactDecisions'
import { EnrichmentProposalDialog } from '../components/enrichment/EnrichmentProposalDialog'
import type { EnrichmentEntityProposal } from '../components/enrichment/EnrichmentProposalDialog'
import { useChatStore } from '../stores/chat.store'
import { usePanelResize } from '../hooks/usePanelResize'
import { mergeContactProposals } from '../../shared/utils/contact-proposal-utils'
import layoutStyles from './TwoColumnLayout.module.css'
import styles from './ContactDetail.module.css'

type ContactTab = 'timeline' | 'meetings' | 'emails' | 'notes' | 'decisions'

export default function ContactDetail() {
  const { contactId: id } = useParams<{ contactId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const backLabel = (location.state as { backLabel?: string } | null)?.backLabel ?? 'Back'
  const [contact, setContact] = useState<ContactDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [activeTab, setActiveTab] = useState<ContactTab>('timeline')
  const { leftWidth, dividerProps } = usePanelResize({ defaultWidth: 360 })
  const [contactEnrichProposals, setContactEnrichProposals] = useState<ContactSummaryUpdateProposal[]>([])
  const [enrichDialogOpen, setEnrichDialogOpen] = useState(false)
  const [fieldSelections, setFieldSelections] = useState<Record<string, boolean>>({})
  const [isApplyingEnrich, setIsApplyingEnrich] = useState(false)
  const [isLoadingEnrich, setIsLoadingEnrich] = useState(false)
  const [enrichSuccessMsg, setEnrichSuccessMsg] = useState<string | null>(null)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [newCompanyModalOpen, setNewCompanyModalOpen] = useState(false)
  const [lastEnrichedAt, setLastEnrichedAt] = useState<string | null>(() => {
    if (!id) return null
    return localStorage.getItem(contactEnrichedAtKey(id))
  })
  const [exaApiKey, setExaApiKey] = useState('')

  const setPageContext = useChatStore((s) => s.setPageContext)

  useEffect(() => {
    if (!id) return
    setLastEnrichedAt(localStorage.getItem(contactEnrichedAtKey(id)))
    setLoading(true)
    window.api
      .invoke<ContactDetailType>(IPC_CHANNELS.CONTACT_GET, id)
      .then((data) => setContact(data ?? null))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    window.api
      .invoke<string>(IPC_CHANNELS.SETTINGS_GET, 'exaApiKey')
      .then((v) => setExaApiKey(v ?? ''))
      .catch(() => { /* ignore — button will simply stay hidden */ })
  }, [])

  // Register this contact as the chat page context so the global floating chat
  // shows entity-scoped options while on this page.
  useEffect(() => {
    if (!contact) return
    setPageContext({ contextOptions: [{ type: 'contact', id: contact.id, name: contact.fullName }] })
    return () => setPageContext(null)
  }, [contact?.id, contact?.fullName, setPageContext])

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

  const showEnrichBanner = useMemo(() => {
    if (!contact) return false
    if (summarizedMeetings.length === 0) return false
    if (!lastEnrichedAt) return true
    return summarizedMeetings.some((m) => m.date > lastEnrichedAt)
  }, [contact, summarizedMeetings, lastEnrichedAt])

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
    setEnrichError(null)
    try {
      const allResults = await Promise.all(
        summarizedMeetings.map((m) =>
          window.api.invoke<ContactSummaryUpdateProposal[]>(IPC_CHANNELS.CONTACT_ENRICH_FROM_MEETING, m.id)
        )
      )
      // Mark as enriched immediately so the banner hides — it will reappear
      // only when new meetings arrive after this timestamp.
      const enrichedAt = new Date().toISOString()
      if (id) {
        localStorage.setItem(contactEnrichedAtKey(id), enrichedAt)
        setLastEnrichedAt(enrichedAt)
      }

      const merged = mergeContactProposals(allResults.flat())
      if (merged.length > 0) {
        // Initialize per-field selections
        const selections: Record<string, boolean> = {}
        for (const p of merged) {
          for (const change of p.changes) {
            selections[`${p.contactId}:${change.field}`] = true
          }
          for (const cfu of p.customFieldUpdates ?? []) {
            selections[`${p.contactId}:${cfu.label}`] = true
          }
        }
        setFieldSelections(selections)
        setContactEnrichProposals(merged)
        setEnrichDialogOpen(true)
      }
    } catch (err) {
      console.error('[ContactDetail] Failed to load enrichment proposals:', err)
      setEnrichError('Could not load enrichment — please try again')
      setTimeout(() => setEnrichError(null), 4000)
    } finally {
      setIsLoadingEnrich(false)
    }
  }, [summarizedMeetings, id])

  const handleApplyEnrich = useCallback(async () => {
    setEnrichDialogOpen(false)
    const accepted = contactEnrichProposals
    if (accepted.length === 0) return
    setIsApplyingEnrich(true)
    try {
      const names: string[] = []
      for (const p of accepted) {
        // Build set of selected field names for this contact
        const selectedFields = new Set(
          p.changes
            .filter((c) => fieldSelections[`${p.contactId}:${c.field}`] !== false)
            .map((c) => c.field)
        )

        // Copy only selected built-in + investor fields
        const filteredUpdates: Record<string, unknown> = {}
        const copyableKeys = [
          'title', 'phone', 'linkedinUrl',
          'fundSize', 'typicalCheckSizeMin', 'typicalCheckSizeMax',
          'investmentStageFocus', 'investmentSectorFocus',
        ] as const
        for (const key of copyableKeys) {
          if (selectedFields.has(key) && (p.updates as Record<string, unknown>)[key] !== undefined) {
            filteredUpdates[key] = (p.updates as Record<string, unknown>)[key]
          }
        }

        // Recompute fieldSources — only keep entries for selected fields
        if (p.updates.fieldSources) {
          try {
            const sources: Record<string, string> = JSON.parse(p.updates.fieldSources)
            const filteredSources: Record<string, string> = {}
            for (const [k, v] of Object.entries(sources)) {
              if (selectedFields.has(k)) filteredSources[k] = v
            }
            if (Object.keys(filteredSources).length > 0) {
              filteredUpdates.fieldSources = JSON.stringify(filteredSources)
            }
          } catch { /* ignore */ }
        }

        if (Object.keys(filteredUpdates).length > 0) {
          await window.api.invoke(IPC_CHANNELS.CONTACT_UPDATE, p.contactId, filteredUpdates)
        }

        // Company link — not per-field selectable
        if (p.companyLink) {
          await window.api.invoke(IPC_CHANNELS.CONTACT_SET_COMPANY, p.contactId, p.companyLink.companyName)
        }

        // Apply selected custom field updates
        if (p.customFieldUpdates) {
          for (const cfu of p.customFieldUpdates) {
            if (fieldSelections[`${p.contactId}:${cfu.label}`] === false) continue
            const input: SetCustomFieldValueInput = {
              fieldDefinitionId: cfu.fieldDefinitionId,
              entityId: p.contactId,
              entityType: 'contact',
            }
            const v = cfu.newValue
            switch (cfu.fieldType) {
              case 'number':
              case 'currency':
                input.valueNumber = Number(v)
                break
              case 'boolean':
                input.valueBoolean = Boolean(v)
                break
              case 'date':
                input.valueDate = String(v)
                break
              case 'multiselect':
                input.valueText = JSON.stringify(v)
                break
              default:
                input.valueText = String(v)
            }
            await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
          }
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
      setContactEnrichProposals([])
      setIsApplyingEnrich(false)
    }
  }, [contactEnrichProposals, fieldSelections, id])

  // Build proposals for shared dialog
  const dialogProposals = useMemo((): EnrichmentEntityProposal[] => {
    return contactEnrichProposals.map((p) => ({
      entityId: p.contactId,
      entityName: p.contactName,
      changes: [
        ...p.changes.map((c) => ({
          key: `${p.contactId}:${c.field}`,
          label: c.field,
          from: c.from,
          to: String(c.to),
        })),
        ...(p.customFieldUpdates ?? []).map((cfu) => ({
          key: `${p.contactId}:${cfu.label}`,
          label: cfu.label,
          from: cfu.fromDisplay,
          to: cfu.toDisplay,
        })),
      ],
    }))
  }, [contactEnrichProposals])

  if (loading) {
    return <div className={layoutStyles.loading}>Loading…</div>
  }
  if (!contact) {
    return <div className={layoutStyles.notFound}>Contact not found.</div>
  }

  const totalActivity = (contact.meetingCount || 0) + (contact.emailCount || 0) + (contact.noteCount || 0)
  const tabs: Array<{ key: ContactTab; label: string; badge?: number }> = [
    { key: 'timeline', label: 'Timeline', badge: totalActivity || undefined },
    { key: 'meetings', label: 'Meetings', badge: contact.meetingCount || undefined },
    { key: 'emails', label: 'Emails', badge: contact.emailCount || undefined },
    { key: 'notes', label: 'Notes', badge: contact.noteCount || undefined },
    { key: 'decisions', label: 'Decisions' }
  ]

  return (
    <div className={styles.wrapper}>
      {window.history.length > 1 && (
        <button className={styles.backBtn} onClick={() => navigate(-1)}>
          ← {backLabel}
        </button>
      )}
    <div className={layoutStyles.layout} style={{ gridTemplateColumns: `${leftWidth}px 4px 1fr` }}>
      {/* Left panel — properties */}
      <div className={layoutStyles.leftPanel}>
        <ContactPropertiesPanel
          contact={contact}
          lastTouchpoint={effectiveLastTouchpoint}
          onUpdate={handleUpdate}
          showEnrichBanner={showEnrichBanner}
          enrichMeetingCount={summarizedMeetings.length}
          fieldSources={parsedFieldSources}
          onEnrichFromMeetings={() => void handleEnrichFromMeetings()}
          isLoadingEnrich={isLoadingEnrich}
          exaApiKey={exaApiKey}
          onRequestCreateCompany={() => setNewCompanyModalOpen(true)}
        />
        {enrichSuccessMsg && (
          <div className={styles.enrichSuccess}>
            ✓ {enrichSuccessMsg}
          </div>
        )}
        {enrichError && (
          <div className={styles.enrichError}>
            {enrichError}
          </div>
        )}
      </div>

      {/* Resizable divider */}
      <div className={layoutStyles.divider} {...dividerProps} />

      {/* Right panel — tabs */}
      <div className={layoutStyles.rightPanel}>
        <div className={layoutStyles.tabBar}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`${layoutStyles.tabBtn} ${activeTab === tab.key ? layoutStyles.tabActive : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className={layoutStyles.tabBadge}>{tab.badge}</span>
              )}
            </button>
          ))}
        </div>

        <div className={layoutStyles.tabContent}>
          <ContactTimeline
            contactId={contact.id}
            hasEmail={!!contact.email}
            className={activeTab !== 'timeline' ? layoutStyles.hidden : ''}
          />
          <ContactMeetings
            meetings={mergedMeetings}
            className={activeTab !== 'meetings' ? layoutStyles.hidden : ''}
          />
          <ContactEmails
            contactId={contact.id}
            hasEmail={!!contact.email}
            className={activeTab !== 'emails' ? layoutStyles.hidden : ''}
          />
          <ContactNotes
            contactId={contact.id}
            className={activeTab !== 'notes' ? layoutStyles.hidden : ''}
          />
          {activeTab === 'decisions' && (
            <ContactDecisions
              contactId={contact.id}
              primaryCompanyId={contact.primaryCompanyId ?? null}
              primaryCompanyName={contact.primaryCompanyName ?? null}
            />
          )}
        </div>
      </div>

      {enrichDialogOpen && contactEnrichProposals.length > 0 && (
        <EnrichmentProposalDialog
          open={true}
          title="Enrich contact profile"
          subtitle="New information was found in meeting summaries. Select which updates to apply."
          proposals={dialogProposals}
          fieldSelections={fieldSelections}
          onFieldToggle={(key, value) => setFieldSelections((prev) => ({ ...prev, [key]: value }))}
          onSelectAll={() => {
            const all: Record<string, boolean> = {}
            for (const p of dialogProposals) for (const c of p.changes) all[c.key] = true
            setFieldSelections(all)
          }}
          onDeselectAll={() => {
            const none: Record<string, boolean> = {}
            for (const p of dialogProposals) for (const c of p.changes) none[c.key] = false
            setFieldSelections(none)
          }}
          onApply={() => void handleApplyEnrich()}
          onSkip={() => {
            setEnrichDialogOpen(false)
            setContactEnrichProposals([])
          }}
          isApplying={isApplyingEnrich}
        />
      )}
      <NewCompanyModal
        open={newCompanyModalOpen}
        onClose={() => setNewCompanyModalOpen(false)}
        onCreated={() => setNewCompanyModalOpen(false)}
      />
    </div>
    </div>
  )
}
