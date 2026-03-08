import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import ConfirmDialog from '../components/common/ConfirmDialog'
import type {
  ContactDetail as ContactDetailType,
  ContactEnrichmentResult,
  ContactEnrichmentOptions,
  ContactEmailIngestResult,
  ContactEmailRef,
  ContactMeetingRef,
  ContactSummary,
  ContactType
} from '../../shared/types/contact'
import type { CompanyDetail as CompanyDetailType, CompanySummary } from '../../shared/types/company'
import type { Meeting } from '../../shared/types/meeting'
import styles from './ContactDetail.module.css'

type ContactTab = 'meetings' | 'emails'

const TAB_LABELS: Record<ContactTab, string> = {
  meetings: 'Meetings',
  emails: 'Emails'
}

const DAY_MS = 1000 * 60 * 60 * 24
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

function formatDateTime(value: string | null | undefined): string {
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return 'Unknown'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

function daysSince(value: string | null | undefined): number | null {
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return null
  return Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
}

function formatDateHeading(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'

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

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  return `${Math.round(seconds / 60)} min`
}

function buildGmailComposeHref(email: string): string {
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`
}

function groupMeetingsByDate(meetings: ContactMeetingRef[]): Array<[string, ContactMeetingRef[]]> {
  const groups = new Map<string, ContactMeetingRef[]>()
  for (const meeting of meetings) {
    const heading = formatDateHeading(meeting.date)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(meeting)
    } else {
      groups.set(heading, [meeting])
    }
  }
  return Array.from(groups.entries())
}

function groupEmailsByDate(emails: ContactEmailRef[]): Array<[string, ContactEmailRef[]]> {
  const groups = new Map<string, ContactEmailRef[]>()
  for (const email of emails) {
    const at = email.receivedAt || email.sentAt
    const heading = formatDateHeading(at || '')
    const existing = groups.get(heading)
    if (existing) {
      existing.push(email)
    } else {
      groups.set(heading, [email])
    }
  }
  return Array.from(groups.entries())
}

function formatEmailParticipantLabel(participant: ContactEmailRef['participants'][number]): string {
  const displayName = (participant.displayName || '').trim()
  return displayName || participant.email
}

function getEmailRecipientGroups(email: ContactEmailRef): {
  to: ContactEmailRef['participants']
  cc: ContactEmailRef['participants']
  bcc: ContactEmailRef['participants']
} {
  const senderEmail = (email.fromEmail || '').trim().toLowerCase()
  const to: ContactEmailRef['participants'] = []
  const cc: ContactEmailRef['participants'] = []
  const bcc: ContactEmailRef['participants'] = []
  const seen = new Set<string>()

  for (const participant of email.participants || []) {
    const role = participant.role
    if (role !== 'to' && role !== 'cc' && role !== 'bcc') continue
    const normalizedEmail = participant.email.trim().toLowerCase()
    if (!normalizedEmail || normalizedEmail === senderEmail) continue
    const dedupeKey = `${role}:${normalizedEmail}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    if (role === 'to') to.push(participant)
    if (role === 'cc') cc.push(participant)
    if (role === 'bcc') bcc.push(participant)
  }

  return { to, cc, bcc }
}

function toDisplayError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const withoutIpcPrefix = raw.replace(/^Error invoking remote method '.*?':\s*/, '')
  return withoutIpcPrefix.replace(/^Error:\s*/, '')
}

function isMissingHandlerError(message: string, channel: string): boolean {
  return message.toLowerCase().includes('no handler registered') && message.includes(channel)
}

function normalizeEmail(value: string | null | undefined): string {
  if (!value) return ''
  return value.trim().toLowerCase().replace(/^mailto:/, '')
}

function extractEmailsFromAttendees(attendees: string[] | null): string[] {
  if (!attendees || attendees.length === 0) return []
  const emails = new Set<string>()

  for (const entry of attendees) {
    const matches = entry.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
    if (!matches) continue
    for (const match of matches) {
      const email = normalizeEmail(match)
      if (email) emails.add(email)
    }
  }

  return [...emails]
}

function mapMeetingHistory(contactEmail: string, meetings: Meeting[]): ContactMeetingRef[] {
  if (!contactEmail) return []
  return meetings
    .filter((meeting) => {
      const direct = (meeting.attendeeEmails || []).map(normalizeEmail)
      if (direct.includes(contactEmail)) return true
      const derived = extractEmailsFromAttendees(meeting.attendees || [])
      return derived.includes(contactEmail)
    })
    .map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      status: meeting.status,
      durationSeconds: meeting.durationSeconds
    }))
    .sort((a, b) => {
      const at = new Date(a.date).getTime()
      const bt = new Date(b.date).getTime()
      return bt - at
    })
}

function splitNameForEditor(fullName: string): { firstName: string; lastName: string } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return { firstName: '', lastName: '' }
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' }
  return {
    firstName: tokens[0],
    lastName: tokens.slice(1).join(' ')
  }
}

function deriveDomainFromWebsite(websiteUrl: string | null | undefined): string | null {
  const raw = (websiteUrl || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const hostname = parsed.hostname.trim().toLowerCase().replace(/^www\./, '')
    return hostname || null
  } catch {
    return null
  }
}

export default function ContactDetail() {
  const { contactId = '' } = useParams()
  const navigate = useNavigate()
  const { enabled: contactsEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')

  const [activeTab, setActiveTab] = useState<ContactTab>('meetings')
  const [contact, setContact] = useState<ContactDetailType | null>(null)
  const [meetings, setMeetings] = useState<ContactMeetingRef[]>([])
  const [emails, setEmails] = useState<ContactEmailRef[]>([])
  const [emailsLoaded, setEmailsLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ingestingEmails, setIngestingEmails] = useState(false)
  const [emailIngestSummary, setEmailIngestSummary] = useState<string | null>(null)
  const [enrichingContact, setEnrichingContact] = useState(false)
  const [contactEnrichmentSummary, setContactEnrichmentSummary] = useState<string | null>(null)
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null)
  const [newContactEmail, setNewContactEmail] = useState('')
  const [addingContactEmail, setAddingContactEmail] = useState(false)
  const [nameUpdateDialog, setNameUpdateDialog] = useState<{ currentName: string; newName: string } | null>(null)
  const [editingContactName, setEditingContactName] = useState(false)
  const [firstNameDraft, setFirstNameDraft] = useState('')
  const [lastNameDraft, setLastNameDraft] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [contactTypeDraft, setContactTypeDraft] = useState<ContactType | ''>('')
  const [linkedinUrlDraft, setLinkedinUrlDraft] = useState('')
  const [savingContactName, setSavingContactName] = useState(false)
  const [companyDraft, setCompanyDraft] = useState('')
  const [companySearchResults, setCompanySearchResults] = useState<CompanySummary[]>([])
  const [showCompanyDropdown, setShowCompanyDropdown] = useState(false)
  const [companyDropdownIndex, setCompanyDropdownIndex] = useState(-1)
  const companySearchRef = useRef<HTMLDivElement>(null)
  const companySearchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const firstNameInputRef = useRef<HTMLInputElement>(null)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const actionsMenuRef = useRef<HTMLDivElement>(null)

  const tabCounts = useMemo(() => ({
    meetings: meetings.length,
    emails: emails.length
  }), [meetings.length, emails.length])

  const loadContactFallback = useCallback(async (): Promise<ContactDetailType | null> => {
    const [contacts, allMeetings] = await Promise.all([
      window.api.invoke<ContactSummary[]>(IPC_CHANNELS.CONTACT_LIST, { limit: 100 }),
      window.api.invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, { limit: 100 })
    ])
    const summary = contacts.find((item) => item.id === contactId)
    if (!summary) return null

    let primaryCompany: ContactDetailType['primaryCompany'] = null
    if (summary.primaryCompanyId) {
      try {
        const company = await window.api.invoke<CompanyDetailType | null>(
          IPC_CHANNELS.COMPANY_GET,
          summary.primaryCompanyId
        )
        if (company) {
          primaryCompany = {
            id: company.id,
            canonicalName: company.canonicalName,
            primaryDomain: company.primaryDomain,
            websiteUrl: company.websiteUrl
          }
        }
      } catch {
        primaryCompany = null
      }
    }

    return {
      ...summary,
      primaryCompany,
      emails: summary.email ? [summary.email] : [],
      meetings: mapMeetingHistory(normalizeEmail(summary.email), allMeetings)
    }
  }, [contactId])

  const loadContact = useCallback(async () => {
    if (!contactId || !contactsEnabled) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.invoke<ContactDetailType | null>(
        IPC_CHANNELS.CONTACT_GET,
        contactId
      )
      setContact(result)
      setMeetings(result?.meetings || [])
      if (!result) {
        setError('Contact not found.')
      }
    } catch (err) {
      const message = toDisplayError(err)
      if (!isMissingHandlerError(message, IPC_CHANNELS.CONTACT_GET)) {
        setContact(null)
        setMeetings([])
        setError(message)
        return
      }

      try {
        const fallbackResult = await loadContactFallback()
        setContact(fallbackResult)
        setMeetings(fallbackResult?.meetings || [])
        if (!fallbackResult) {
          setError('Contact not found.')
        }
      } catch (fallbackErr) {
        setContact(null)
        setMeetings([])
        setError(toDisplayError(fallbackErr))
      }
    } finally {
      setLoading(false)
    }
  }, [contactId, contactsEnabled, loadContactFallback])

  const loadEmails = useCallback(async (force = false) => {
    if (!contactId) return []
    if (emailsLoaded && !force) return []
    try {
      const result = await window.api.invoke<ContactEmailRef[]>(
        IPC_CHANNELS.CONTACT_EMAILS,
        contactId
      )
      setEmails(result)
      return result
    } catch (err) {
      const message = toDisplayError(err)
      if (isMissingHandlerError(message, IPC_CHANNELS.CONTACT_EMAILS)) {
        const restartMessage = 'Contact email tab requires the latest app runtime. Restart the app and try again.'
        setError((prev) => (prev ? `${prev} | ${restartMessage}` : restartMessage))
        setEmails([])
      } else {
        setError((prev) => (prev ? `${prev} | ${message}` : message))
      }
      return []
    } finally {
      setEmailsLoaded(true)
    }
  }, [contactId, emailsLoaded])

  const promptForContactNameUpdate = useCallback((suggestedFullName: string | null) => {
    if (!suggestedFullName || !contact?.email) return

    const currentFullName = contact.fullName.trim()
    const nextFullName = suggestedFullName.trim()
    if (!nextFullName || nextFullName === currentFullName) return

    setNameUpdateDialog({ currentName: currentFullName, newName: nextFullName })
  }, [contact])

  const handleConfirmNameUpdate = useCallback(async () => {
    if (!nameUpdateDialog || !contact?.email) return
    setNameUpdateDialog(null)
    const parsed = splitNameForEditor(nameUpdateDialog.newName)

    const updated = await window.api.invoke<ContactSummary>(IPC_CHANNELS.CONTACT_CREATE, {
      fullName: nameUpdateDialog.newName,
      firstName: parsed.firstName || null,
      lastName: parsed.lastName || null,
      email: contact.email,
      title: contact.title
    })

    setContact((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        fullName: updated.fullName,
        firstName: updated.firstName,
        lastName: updated.lastName,
        normalizedName: updated.normalizedName,
        updatedAt: updated.updatedAt
      }
    })
  }, [nameUpdateDialog, contact])

  useEffect(() => {
    loadContact()
  }, [loadContact])

  useEffect(() => {
    if (!contact || editingContactName) return
    const parsed = splitNameForEditor(contact.fullName)
    setFirstNameDraft((contact.firstName || '').trim() || parsed.firstName)
    setLastNameDraft((contact.lastName || '').trim() || parsed.lastName)
  }, [contact, editingContactName])

  useEffect(() => {
    setEmails([])
    setEmailsLoaded(false)
    setEmailIngestSummary(null)
    setEnrichingContact(false)
    setContactEnrichmentSummary(null)
    setExpandedEmailId(null)
    setActiveTab('meetings')
    setEditingContactName(false)
    setFirstNameDraft('')
    setLastNameDraft('')
    setTitleDraft('')
    setContactTypeDraft('')
    setLinkedinUrlDraft('')
    setSavingContactName(false)
  }, [contactId])

  useEffect(() => {
    if (activeTab === 'emails' && contact) {
      void loadEmails()
    }
  }, [activeTab, contact, loadEmails])

  useEffect(() => {
    if (emails.length === 0) {
      setExpandedEmailId(null)
      return
    }
    if (expandedEmailId && !emails.some((email) => email.id === expandedEmailId)) {
      setExpandedEmailId(null)
    }
  }, [emails, expandedEmailId])

  const handleIngestContactEmails = useCallback(async () => {
    if (!contactId) return
    setIngestingEmails(true)
    setError(null)
    setEmailIngestSummary(null)
    try {
      const result = await window.api.invoke<ContactEmailIngestResult>(
        IPC_CHANNELS.CONTACT_EMAIL_INGEST,
        contactId
      )
      setEmailIngestSummary(
        `${result.insertedMessageCount} new, ${result.updatedMessageCount} updated, ${result.linkedMessageCount} linked`
      )
      await loadEmails(true)
      setActiveTab('emails')
      promptForContactNameUpdate(result.suggestedFullName)
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setIngestingEmails(false)
    }
  }, [contactId, loadEmails, promptForContactNameUpdate])

  const handleEnrichContact = useCallback(async (webLookup = false) => {
    if (!contactId) return
    setEnrichingContact(true)
    setError(null)
    setContactEnrichmentSummary(null)
    try {
      const options: ContactEnrichmentOptions | undefined = webLookup
        ? { webLookup: true, webLookupLimit: 1 }
        : undefined
      const result = await window.api.invoke<ContactEnrichmentResult>(
        IPC_CHANNELS.CONTACT_ENRICH_ONE,
        contactId,
        options
      )
      setContactEnrichmentSummary(
        `Enrichment complete. Names: ${result.updatedNames}, LinkedIn: ${result.updatedLinkedinUrls}, Titles: ${result.updatedTitles}, Companies: ${result.linkedCompanies}${result.webLookups > 0 ? `, Web lookups: ${result.webLookups}` : ''}.`
      )
      await loadContact()
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setEnrichingContact(false)
    }
  }, [contactId, loadContact])

  const handleOpenWebsite = useCallback(async (url: string) => {
    try {
      await window.api.invoke<boolean>(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url)
    } catch (err) {
      setError(toDisplayError(err))
    }
  }, [])

  const handleComposeEmail = useCallback(async (email: string) => {
    const normalized = normalizeEmail(email)
    if (!normalized) {
      setError('Valid contact email is required.')
      return
    }
    try {
      await window.api.invoke<boolean>(
        IPC_CHANNELS.APP_OPEN_EXTERNAL_URL,
        buildGmailComposeHref(normalized)
      )
    } catch (err) {
      setError(toDisplayError(err))
    }
  }, [])

  const toggleExpandedEmail = useCallback((emailId: string) => {
    setExpandedEmailId((prev) => (prev === emailId ? null : emailId))
  }, [])

  const startContactNameEdit = useCallback(() => {
    if (!contact || savingContactName) return
    const parsed = splitNameForEditor(contact.fullName)
    setFirstNameDraft((contact.firstName || '').trim() || parsed.firstName)
    setLastNameDraft((contact.lastName || '').trim() || parsed.lastName)
    setTitleDraft(contact.title || '')
    setContactTypeDraft(contact.contactType || '')
    setLinkedinUrlDraft(contact.linkedinUrl || '')
    setCompanyDraft(contact.primaryCompany?.canonicalName || '')
    setEditingContactName(true)
    setTimeout(() => {
      const input = firstNameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    }, 0)
  }, [contact, savingContactName])

  const cancelContactNameEdit = useCallback(() => {
    if (contact) {
      const parsed = splitNameForEditor(contact.fullName)
      setFirstNameDraft((contact.firstName || '').trim() || parsed.firstName)
      setLastNameDraft((contact.lastName || '').trim() || parsed.lastName)
      setTitleDraft(contact.title || '')
      setContactTypeDraft(contact.contactType || '')
      setLinkedinUrlDraft(contact.linkedinUrl || '')
      setCompanyDraft(contact.primaryCompany?.canonicalName || '')
    } else {
      setFirstNameDraft('')
      setLastNameDraft('')
      setTitleDraft('')
      setContactTypeDraft('')
      setLinkedinUrlDraft('')
      setCompanyDraft('')
    }
    setShowCompanyDropdown(false)
    setCompanySearchResults([])
    setEditingContactName(false)
  }, [contact])

  // Company search: debounced query
  useEffect(() => {
    if (companySearchDebounceRef.current) clearTimeout(companySearchDebounceRef.current)
    const q = companyDraft.trim()
    if (q.length < 2 || q === (contact?.primaryCompany?.canonicalName || '')) {
      setCompanySearchResults([])
      setShowCompanyDropdown(false)
      return
    }
    companySearchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await window.api.invoke<CompanySummary[]>(
          IPC_CHANNELS.COMPANY_LIST,
          { query: q, limit: 8 }
        )
        setCompanySearchResults(results)
        setShowCompanyDropdown(results.length > 0)
        setCompanyDropdownIndex(-1)
      } catch {
        setCompanySearchResults([])
        setShowCompanyDropdown(false)
      }
    }, 150)
    return () => {
      if (companySearchDebounceRef.current) clearTimeout(companySearchDebounceRef.current)
    }
  }, [companyDraft, contact?.primaryCompany?.canonicalName])

  // Company search: click-outside to close dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (companySearchRef.current && !companySearchRef.current.contains(e.target as Node)) {
        setShowCompanyDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!actionsMenuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [actionsMenuOpen])

  const handleCompanySelect = useCallback((company: CompanySummary) => {
    setCompanyDraft(company.canonicalName)
    setShowCompanyDropdown(false)
    setCompanySearchResults([])
  }, [])

  const handleCompanySearchKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (!showCompanyDropdown || companySearchResults.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCompanyDropdownIndex((prev) => Math.min(prev + 1, companySearchResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCompanyDropdownIndex((prev) => Math.max(prev - 1, -1))
    } else if (e.key === 'Enter' && companyDropdownIndex >= 0) {
      e.preventDefault()
      handleCompanySelect(companySearchResults[companyDropdownIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowCompanyDropdown(false)
    }
  }, [showCompanyDropdown, companySearchResults, companyDropdownIndex, handleCompanySelect])

  const saveContactName = useCallback(async () => {
    if (!contact || savingContactName) return
    const nextFirstName = firstNameDraft.trim()
    const nextLastName = lastNameDraft.trim()
    const nextName = [nextFirstName, nextLastName].filter(Boolean).join(' ').trim()
    if (!nextName) {
      setError('Contact name is required')
      cancelContactNameEdit()
      return
    }

    const nextTitle = titleDraft.trim() || null
    const nextContactType = (contactTypeDraft || null) as ContactType | null
    const nextLinkedinUrl = linkedinUrlDraft.trim() || null

    setSavingContactName(true)
    setError(null)
    try {
      let updated = await window.api.invoke<ContactDetailType>(
        IPC_CHANNELS.CONTACT_UPDATE,
        contact.id,
        {
          fullName: nextName,
          firstName: nextFirstName || null,
          lastName: nextLastName || null,
          title: nextTitle,
          contactType: nextContactType,
          linkedinUrl: nextLinkedinUrl
        }
      )

      const nextCompany = companyDraft.trim()
      const currentCompany = contact.primaryCompany?.canonicalName || ''
      if (nextCompany && nextCompany !== currentCompany) {
        updated = await window.api.invoke<ContactDetailType>(
          IPC_CHANNELS.CONTACT_SET_COMPANY,
          contact.id,
          nextCompany
        )
      }

      setContact(updated)
      setMeetings(updated.meetings || [])
      setFirstNameDraft(updated.firstName || '')
      setLastNameDraft(updated.lastName || '')
      setEditingContactName(false)
    } catch (err) {
      setError(toDisplayError(err))
    } finally {
      setSavingContactName(false)
    }
  }, [contact, firstNameDraft, lastNameDraft, titleDraft, contactTypeDraft, linkedinUrlDraft, companyDraft, savingContactName, cancelContactNameEdit])

  const handleContactNameInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveContactName()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelContactNameEdit()
    }
  }, [saveContactName, cancelContactNameEdit])

  if (!flagsLoading && !contactsEnabled) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Contacts view is disabled by feature flag.</div>
      </div>
    )
  }

  if (!contactId) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>Missing contact id.</div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.meta}>Loading contact...</div>
      </div>
    )
  }

  if (!contact) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>{error || 'Contact not found.'}</div>
      </div>
    )
  }

  const canSaveContactName = !savingContactName
    && ([firstNameDraft.trim(), lastNameDraft.trim()].filter(Boolean).join(' ').trim().length > 0)
  const primaryEmail = normalizeEmail(contact.email)
  const lastTouchTimestamp = contact.lastTouchpoint || contact.updatedAt
  const lastTouchDays = daysSince(lastTouchTimestamp)
  const lastTouchBadgeClass = lastTouchDays == null
    ? styles.warmthUnknown
    : lastTouchDays < 14
        ? styles.warmthGreen
        : lastTouchDays <= 30
            ? styles.warmthYellow
            : styles.warmthRed
  const companyFaviconDomain = (
    contact.primaryCompany?.primaryDomain?.trim()
    || deriveDomainFromWebsite(contact.primaryCompany?.websiteUrl)
    || ''
  ).toLowerCase()

  return (
    <div className={styles.page}>
      <button className={styles.backButton} onClick={() => navigate('/contacts')}>
        {'< Back to Contacts'}
      </button>

      <div className={styles.headerCard}>
        <div className={styles.titleRow}>
          {editingContactName ? (
            <div className={styles.editForm}>
              <div className={styles.editRow}>
                <label className={styles.editLabel}>Name</label>
                <div className={styles.editFieldGroup}>
                  <input
                    ref={firstNameInputRef}
                    className={styles.nameInput}
                    value={firstNameDraft}
                    onChange={(event) => setFirstNameDraft(event.target.value)}
                    onKeyDown={handleContactNameInputKeyDown}
                    disabled={savingContactName}
                    placeholder="First name"
                    aria-label="First name"
                  />
                  <input
                    className={styles.nameInput}
                    value={lastNameDraft}
                    onChange={(event) => setLastNameDraft(event.target.value)}
                    onKeyDown={handleContactNameInputKeyDown}
                    disabled={savingContactName}
                    placeholder="Last name"
                    aria-label="Last name"
                  />
                </div>
              </div>
              <div className={styles.editRow}>
                <label className={styles.editLabel}>Job Title</label>
                <input
                  className={styles.editInput}
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={handleContactNameInputKeyDown}
                  disabled={savingContactName}
                  placeholder="e.g. Partner, CEO, Engineering Manager"
                  aria-label="Job title"
                />
              </div>
              <div className={styles.editRow}>
                <label className={styles.editLabel}>Type</label>
                <select
                  className={styles.editSelect}
                  value={contactTypeDraft}
                  onChange={(event) => setContactTypeDraft(event.target.value as ContactType | '')}
                  disabled={savingContactName}
                  aria-label="Contact type"
                >
                  <option value="">Not set</option>
                  <option value="investor">Investor</option>
                  <option value="founder">Founder</option>
                  <option value="operator">Operator</option>
                </select>
              </div>
              <div className={styles.editRow}>
                <label className={styles.editLabel}>LinkedIn</label>
                <input
                  className={styles.editInput}
                  value={linkedinUrlDraft}
                  onChange={(event) => setLinkedinUrlDraft(event.target.value)}
                  onKeyDown={handleContactNameInputKeyDown}
                  disabled={savingContactName}
                  placeholder="https://linkedin.com/in/..."
                  aria-label="LinkedIn URL"
                />
              </div>
              <div className={styles.editRow}>
                <label className={styles.editLabel}>Company</label>
                <div className={styles.companySearchWrapper} ref={companySearchRef}>
                  <input
                    className={styles.editInput}
                    value={companyDraft}
                    onChange={(e) => setCompanyDraft(e.target.value)}
                    onKeyDown={handleCompanySearchKeyDown}
                    onFocus={() => {
                      if (companySearchResults.length > 0) setShowCompanyDropdown(true)
                    }}
                    disabled={savingContactName}
                    placeholder="Search or type company name"
                    aria-label="Company name"
                  />
                  {showCompanyDropdown && companySearchResults.length > 0 && (
                    <div className={styles.companyDropdown}>
                      {companySearchResults.map((c, i) => (
                        <div
                          key={c.id}
                          className={`${styles.companyDropdownItem} ${i === companyDropdownIndex ? styles.companyDropdownActive : ''}`}
                          onMouseDown={() => handleCompanySelect(c)}
                          onMouseEnter={() => setCompanyDropdownIndex(i)}
                        >
                          <span className={styles.companyDropdownName}>{c.canonicalName}</span>
                          {c.primaryDomain && <span className={styles.companyDropdownDomain}>{c.primaryDomain}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.editActions}>
                <button
                  type="button"
                  className={styles.nameSaveButton}
                  onClick={() => void saveContactName()}
                  disabled={!canSaveContactName}
                >
                  {savingContactName ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  className={styles.nameCancelButton}
                  onClick={cancelContactNameEdit}
                  disabled={savingContactName}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <h2 className={styles.title}>{contact.fullName}</h2>
              {(contact.primaryCompany || contact.title || contact.contactType) && (
                <div className={styles.subtitleRow}>
                  {contact.primaryCompany && (
                    <button
                      type="button"
                      className={styles.companySubtitle}
                      onClick={() => navigate(`/company/${contact.primaryCompany.id}`)}
                    >
                      {companyFaviconDomain && (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(companyFaviconDomain)}&sz=32`}
                          alt=""
                          className={styles.companyFavicon}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      {contact.primaryCompany.canonicalName}
                    </button>
                  )}
                  {(contact.title || contact.contactType) && (
                    <div className={styles.titleChipRow}>
                      {contact.title && (
                        <span className={styles.titleSubtitle}>{contact.title}</span>
                      )}
                      {contact.contactType && (
                        <span className={styles.contactTypeBadge}>
                          {contact.contactType.charAt(0).toUpperCase() + contact.contactType.slice(1)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className={styles.headerActions} ref={actionsMenuRef}>
                <button
                  type="button"
                  className={styles.secondaryHeaderButton}
                  onClick={() => setActionsMenuOpen((v) => !v)}
                  disabled={enrichingContact}
                >
                  {enrichingContact ? 'Enriching...' : 'Actions'}
                </button>
                {actionsMenuOpen && (
                  <div className={styles.actionsDropdown}>
                    <button
                      className={styles.actionsDropdownItem}
                      onClick={() => { setActionsMenuOpen(false); startContactNameEdit() }}
                    >
                      Edit
                    </button>
                    <button
                      className={styles.actionsDropdownItem}
                      onClick={() => { setActionsMenuOpen(false); void handleEnrichContact(false) }}
                    >
                      Enrich contact
                    </button>
                    <button
                      className={styles.actionsDropdownItem}
                      onClick={() => { setActionsMenuOpen(false); void handleEnrichContact(true) }}
                    >
                      Enrich + web
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className={styles.metaRow}>
          {primaryEmail ? (
            <button
              type="button"
              className={styles.emailLink}
              onClick={() => void handleComposeEmail(primaryEmail)}
            >
              {primaryEmail}
            </button>
          ) : (
            <span>No email</span>
          )}
          {contact.linkedinUrl && (
            <button
              type="button"
              className={styles.emailLink}
              onClick={() => void handleOpenWebsite(contact.linkedinUrl!)}
            >
              LinkedIn
            </button>
          )}
          <span className={styles.touchMeta}>
            <span>Last touch: {formatDateTime(lastTouchTimestamp)}</span>
            <span className={`${styles.warmthBadge} ${lastTouchBadgeClass}`}>
              {lastTouchDays == null ? '--' : `${lastTouchDays}d`}
            </span>
          </span>
        </div>
        {contactEnrichmentSummary && (
          <div className={styles.metaNote}>{contactEnrichmentSummary}</div>
        )}
      </div>

      <div className={styles.tabRow}>
        {(['meetings', 'emails'] as ContactTab[]).map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className={styles.tabLabel}>{TAB_LABELS[tab]}</span>
            <span className={styles.tabCount}>{tabCounts[tab]}</span>
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {activeTab === 'meetings' && (
        <div className={styles.section}>
          {meetings.length === 0 && (
            <div className={styles.empty}>No meetings found for this contact yet.</div>
          )}
          {meetings.length > 0 && (
            <div className={styles.meetingListView}>
              {groupMeetingsByDate(meetings).map(([dateHeading, groupedMeetings]) => (
                <div key={dateHeading} className={styles.meetingDateGroup}>
                  <div className={styles.meetingDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.meetingRows}>
                    {groupedMeetings.map((meeting) => (
                      <button
                        key={meeting.id}
                        className={styles.meetingRow}
                        onClick={() => navigate(`/meeting/${meeting.id}`)}
                      >
                        <div className={styles.meetingRowTop}>
                          <span className={styles.meetingRowTitle}>{meeting.title}</span>
                          <span className={styles.meetingRowTime}>{formatTime(meeting.date)}</span>
                        </div>
                        <div className={styles.meetingRowMeta}>
                          {[meeting.status, formatDuration(meeting.durationSeconds)].filter(Boolean).join(' | ')}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'emails' && (
        <div className={styles.section}>
          <div className={styles.emailActions}>
            <button
              className={styles.secondaryButton}
              onClick={handleIngestContactEmails}
              disabled={ingestingEmails}
            >
              {ingestingEmails ? 'Ingesting from Gmail...' : 'Ingest from Gmail'}
            </button>
            {emailIngestSummary && (
              <span className={styles.emailIngestMeta}>{emailIngestSummary}</span>
            )}
          </div>
          {ingestingEmails && (
            <div className={styles.ingestStatus} role="status" aria-live="polite">
              <span className={styles.loadingDot} aria-hidden="true" />
              <span>Syncing Gmail for this contact. You can keep using the app while this runs.</span>
            </div>
          )}

          {!emailsLoaded && <div className={styles.meta}>Loading emails...</div>}

          {emailsLoaded && emails.length === 0 && (
            <div className={styles.empty}>No emails linked to this contact yet.</div>
          )}

          {emails.length > 0 && (
            <div className={styles.emailListView}>
              {groupEmailsByDate(emails).map(([dateHeading, groupedEmails]) => (
                <div key={dateHeading} className={styles.emailDateGroup}>
                  <div className={styles.emailDateHeader}>
                    <span>{dateHeading}</span>
                  </div>
                  <div className={styles.emailRows}>
                    {groupedEmails.map((email) => {
                      const expanded = expandedEmailId === email.id
                      const recipients = getEmailRecipientGroups(email)
                      return (
                        <div
                          key={email.id}
                          className={`${styles.emailRow} ${expanded ? styles.emailRowExpanded : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleExpandedEmail(email.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              toggleExpandedEmail(email.id)
                            }
                          }}
                        >
                          <div className={styles.emailRowTop}>
                            <span className={styles.emailRowSubject}>{email.subject?.trim() || '(no subject)'}</span>
                            <span className={styles.emailRowTime}>{formatTime(email.receivedAt || email.sentAt || '')}</span>
                          </div>
                          <div className={styles.emailRowMeta}>
                            {[
                              email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail,
                              email.threadMessageCount > 1 ? `${email.threadMessageCount} messages in thread` : null
                            ].filter(Boolean).join(' | ')}
                          </div>
                          {(recipients.to.length > 0 || recipients.cc.length > 0 || recipients.bcc.length > 0) && (
                            <div className={styles.emailRecipients}>
                              {([
                                ['To', recipients.to],
                                ['Cc', recipients.cc],
                                ['Bcc', recipients.bcc]
                              ] as const).map(([label, participants]) => (
                                participants.length > 0 ? (
                                  <div key={label} className={styles.emailRecipientRow}>
                                    <span className={styles.emailRecipientRole}>{label}:</span>
                                    <span className={styles.emailRecipientList}>
                                      {participants.map((participant, index) => (
                                        <span key={`${participant.role}:${participant.email}`} className={styles.emailRecipientToken}>
                                          {participant.contactId ? (
                                            <button
                                              type="button"
                                              className={styles.emailRecipientLink}
                                              onClick={(event) => {
                                                event.stopPropagation()
                                                navigate(`/contact/${participant.contactId}`)
                                              }}
                                              onKeyDown={(event) => {
                                                event.stopPropagation()
                                              }}
                                            >
                                              {formatEmailParticipantLabel(participant)}
                                            </button>
                                          ) : (
                                            <span className={styles.emailRecipientText}>
                                              {formatEmailParticipantLabel(participant)}
                                            </span>
                                          )}
                                          {index < participants.length - 1 && (
                                            <span className={styles.emailRecipientDelimiter}>, </span>
                                          )}
                                        </span>
                                      ))}
                                    </span>
                                  </div>
                                ) : null
                              ))}
                            </div>
                          )}
                          {expanded ? (
                            <div className={styles.emailRowBody}>
                              {email.bodyText?.trim()
                                || email.snippet?.trim()
                                || 'No email body available for this message.'}
                            </div>
                          ) : (
                            email.snippet && <div className={styles.emailRowSnippet}>{email.snippet}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className={styles.meta}>
                Click an email row to {expandedEmailId ? 'collapse/expand details' : 'expand details'}.
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={nameUpdateDialog !== null}
        title="Update contact name"
        message={
          nameUpdateDialog?.currentName
            ? `Email sender info suggests a fuller name for this contact. Update name from "${nameUpdateDialog.currentName}" to "${nameUpdateDialog.newName}"?`
            : `Email sender info suggests a name for this contact. Set contact name to "${nameUpdateDialog?.newName}"?`
        }
        onConfirm={() => void handleConfirmNameUpdate()}
        onCancel={() => setNameUpdateDialog(null)}
      />
    </div>
  )
}
