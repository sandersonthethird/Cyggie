import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import ChatInterface from '../components/chat/ChatInterface'
import type {
  ContactSortBy,
  ContactSummary,
  ContactSyncResult,
  ContactEnrichmentResult,
  ContactEnrichmentOptions
} from '../../shared/types/contact'
import styles from './Contacts.module.css'

const DAY_MS = 1000 * 60 * 60 * 24
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN

  // SQLite DATETIME values are stored in UTC without a timezone marker.
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

function formatDate(value: string): string {
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return ''
  const date = new Date(timestamp)
  const diffMs = Date.now() - timestamp
  const diffDays = Math.max(0, Math.floor(diffMs / DAY_MS))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function daysSince(value: string | null): number | null {
  if (!value) return null
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return null
  return Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
}

function normalizeSortKey(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

function sortContacts(contacts: ContactSummary[], sortBy: ContactSortBy): ContactSummary[] {
  if (contacts.length <= 1) return contacts
  const sorted = [...contacts]
  sorted.sort((a, b) => {
    if (sortBy === 'first_name') {
      const aFirst = normalizeSortKey(a.firstName || a.fullName)
      const bFirst = normalizeSortKey(b.firstName || b.fullName)
      if (aFirst !== bFirst) return aFirst.localeCompare(bFirst)

      const aLast = normalizeSortKey(a.lastName || a.fullName)
      const bLast = normalizeSortKey(b.lastName || b.fullName)
      if (aLast !== bLast) return aLast.localeCompare(bLast)
    } else if (sortBy === 'last_name') {
      const aLast = normalizeSortKey(a.lastName || a.fullName)
      const bLast = normalizeSortKey(b.lastName || b.fullName)
      if (aLast !== bLast) return aLast.localeCompare(bLast)

      const aFirst = normalizeSortKey(a.firstName || a.fullName)
      const bFirst = normalizeSortKey(b.firstName || b.fullName)
      if (aFirst !== bFirst) return aFirst.localeCompare(bFirst)
    } else if (sortBy === 'company') {
      const aCompany = normalizeSortKey(a.primaryCompanyName)
      const bCompany = normalizeSortKey(b.primaryCompanyName)
      if (aCompany !== bCompany) {
        if (!aCompany) return 1
        if (!bCompany) return -1
        return aCompany.localeCompare(bCompany)
      }
    } else {
      const aTouch = parseTimestamp(a.lastTouchpoint || a.updatedAt || a.createdAt)
      const bTouch = parseTimestamp(b.lastTouchpoint || b.updatedAt || b.createdAt)
      if (Number.isNaN(aTouch) && !Number.isNaN(bTouch)) return 1
      if (!Number.isNaN(aTouch) && Number.isNaN(bTouch)) return -1
      if (aTouch !== bTouch) return bTouch - aTouch
    }

    const aName = normalizeSortKey(a.fullName)
    const bName = normalizeSortKey(b.fullName)
    if (aName !== bName) return aName.localeCompare(bName)
    return normalizeSortKey(a.email).localeCompare(normalizeSortKey(b.email))
  })
  return sorted
}

export default function Contacts() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: contactsEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<ContactSyncResult | null>(null)
  const [enrichmentResult, setEnrichmentResult] = useState<ContactEnrichmentResult | null>(null)
  const [newFirstName, setNewFirstName] = useState('')
  const [newLastName, setNewLastName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newContactType, setNewContactType] = useState('')
  const [newLinkedinUrl, setNewLinkedinUrl] = useState('')
  const [newCompanyName, setNewCompanyName] = useState('')
  const [useWebLookup, setUseWebLookup] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const createCardRef = useRef<HTMLDivElement>(null)
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'
  const rawSort = (searchParams.get('sort') || '').trim()
  const sortBy: ContactSortBy = rawSort === 'first_name'
    || rawSort === 'last_name'
    || rawSort === 'company'
    || rawSort === 'recent_touch'
    ? rawSort
    : 'recent_touch'

  const openCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.set('new', '1')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const closeCreateForm = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const setSort = useCallback((nextSort: ContactSortBy) => {
    const next = new URLSearchParams(searchParams)
    if (nextSort === 'recent_touch') {
      next.delete('sort')
    } else {
      next.set('sort', nextSort)
    }
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const loadContacts = useCallback(async (searchQuery: string) => {
    if (!contactsEnabled) return
    setLoading(true)
    setError(null)
    try {
      const results = await window.api.invoke<ContactSummary[]>(
        IPC_CHANNELS.CONTACT_LIST,
        {
          query: searchQuery.trim(),
          limit: 500,
          includeStats: false,
          includeActivityTouchpoint: true
        }
      )
      setContacts(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [contactsEnabled])

  const syncContacts = useCallback(async () => {
    if (!contactsEnabled) return
    setSyncing(true)
    setError(null)
    setEnrichmentResult(null)
    try {
      const result = await window.api.invoke<ContactSyncResult>(
        IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS
      )
      setSyncResult(result)
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    } finally {
      setSyncing(false)
    }
  }, [contactsEnabled, loadContacts, query])

  const enrichContacts = useCallback(async () => {
    if (!contactsEnabled) return
    setEnriching(true)
    setError(null)
    try {
      const options: ContactEnrichmentOptions | undefined = useWebLookup
        ? { webLookup: true }
        : undefined
      const result = await window.api.invoke<ContactEnrichmentResult>(
        IPC_CHANNELS.CONTACT_ENRICH_EXISTING,
        options
      )
      setEnrichmentResult(result)
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    } finally {
      setEnriching(false)
    }
  }, [contactsEnabled, loadContacts, query, useWebLookup])

  const handleCreateContact = async () => {
    if (!newFirstName.trim() || !newLastName.trim()) return
    const fullName = `${newFirstName.trim()} ${newLastName.trim()}`
    try {
      const created = await window.api.invoke<ContactSummary>(
        IPC_CHANNELS.CONTACT_CREATE,
        {
          fullName,
          firstName: newFirstName.trim(),
          lastName: newLastName.trim(),
          email: newEmail.trim() || null,
          title: newTitle.trim() || null,
          contactType: newContactType || null,
          linkedinUrl: newLinkedinUrl.trim() || null,
          companyName: newCompanyName.trim() || null
        }
      )
      closeCreateForm()
      setNewFirstName('')
      setNewLastName('')
      setNewEmail('')
      setNewTitle('')
      setNewContactType('')
      setNewLinkedinUrl('')
      setNewCompanyName('')
      navigate(`/contact/${created.id}`)
    } catch (err) {
      setError(String(err))
    }
  }

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!query) {
      loadContacts('')
      return
    }
    searchDebounceRef.current = setTimeout(() => {
      loadContacts(query)
    }, 300)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [loadContacts, query])

  useEffect(() => {
    if (!showCreate) return
    createCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showCreate])

  useEffect(() => {
    if (!actionsOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [actionsOpen])

  if (!flagsLoading && !contactsEnabled) {
    return (
      <EmptyState
        title="Contacts disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  const sortedContacts = useMemo(() => sortContacts(contacts, sortBy), [contacts, sortBy])
  const showEmptyState = !loading && sortedContacts.length === 0 && !query && !showCreate

  return (
    <div className={styles.container}>
      {syncResult && (
        <span className={styles.syncMeta}>
          {syncResult.inserted} new, {syncResult.updated} updated
        </span>
      )}
      {enrichmentResult && (
        <span className={styles.syncMeta}>
          Names: {enrichmentResult.updatedNames}, LinkedIn: {enrichmentResult.updatedLinkedinUrls}, Titles: {enrichmentResult.updatedTitles}, Companies: {enrichmentResult.linkedCompanies}
          {enrichmentResult.webLookups > 0 ? `, Web lookups: ${enrichmentResult.webLookups}` : ''}
        </span>
      )}

      <div className={styles.controlsRow}>
        <div className={styles.sortGroup}>
          <label htmlFor="contact-sort" className={styles.sortLabel}>Sort</label>
          <select
            id="contact-sort"
            className={styles.sortSelect}
            value={sortBy}
            onChange={(e) => setSort(e.target.value as ContactSortBy)}
          >
            <option value="recent_touch">Recent touch</option>
            <option value="first_name">First name (A-Z)</option>
            <option value="last_name">Last name (A-Z)</option>
            <option value="company">Company (A-Z)</option>
          </select>
        </div>
        <div className={styles.controlsRight}>
          <label className={styles.lookupToggle}>
            <input
              type="checkbox"
              checked={useWebLookup}
              onChange={(e) => setUseWebLookup(e.target.checked)}
            />
            Web lookup
          </label>
          <div className={styles.actionsDropdown} ref={actionsRef}>
            <button
              className={styles.actionsBtn}
              onClick={() => setActionsOpen((v) => !v)}
            >
              Actions &#9662;
            </button>
            {actionsOpen && (
              <div className={styles.actionsMenu}>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { syncContacts(); setActionsOpen(false) }}
                  disabled={syncing || enriching}
                >
                  {syncing ? 'Syncing...' : 'Sync from Meetings'}
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { enrichContacts(); setActionsOpen(false) }}
                  disabled={syncing || enriching}
                >
                  {enriching ? 'Enriching...' : 'Enrich Contacts'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreate && (
        <div ref={createCardRef} className={styles.createCard}>
          <h3 className={styles.createTitle}>New Contact</h3>
          <div className={styles.createFormGrid}>
            <div className={styles.createField}>
              <label className={styles.createLabel}>First Name *</label>
              <input
                className={styles.input}
                placeholder="First name"
                value={newFirstName}
                onChange={(e) => setNewFirstName(e.target.value)}
                autoFocus
              />
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>Last Name *</label>
              <input
                className={styles.input}
                placeholder="Last name"
                value={newLastName}
                onChange={(e) => setNewLastName(e.target.value)}
              />
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>Email</label>
              <input
                className={styles.input}
                placeholder="email@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>Job Title</label>
              <input
                className={styles.input}
                placeholder="e.g. Partner, CEO, Engineering Manager"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>Type</label>
              <select
                className={styles.createSelect}
                value={newContactType}
                onChange={(e) => setNewContactType(e.target.value)}
              >
                <option value="">Not set</option>
                <option value="investor">Investor</option>
                <option value="founder">Founder</option>
                <option value="operator">Operator</option>
              </select>
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>LinkedIn</label>
              <input
                className={styles.input}
                placeholder="https://linkedin.com/in/..."
                value={newLinkedinUrl}
                onChange={(e) => setNewLinkedinUrl(e.target.value)}
              />
            </div>
            <div className={styles.createField}>
              <label className={styles.createLabel}>Company</label>
              <input
                className={styles.input}
                placeholder="Company name"
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
              />
            </div>
          </div>
          <div className={styles.createActions}>
            <button
              className={styles.createBtn}
              onClick={handleCreateContact}
              disabled={!newFirstName.trim() || !newLastName.trim()}
            >
              Create Contact
            </button>
            <button className={styles.createCancelBtn} onClick={closeCreateForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {query && (
        <p className={styles.resultCount}>
          {loading ? 'Searching...' : `${sortedContacts.length} contact${sortedContacts.length !== 1 ? 's' : ''}`}
        </p>
      )}

      <div className={styles.scrollArea}>
        {showEmptyState ? (
          <EmptyState
            title="No contacts yet"
            description="Contacts are synced from meeting attendees. Click 'Sync from meetings' to populate."
            action={{ label: '+ New Contact', onClick: openCreateForm }}
          />
        ) : (
          <div className={styles.section}>
            <h3 className={styles.sectionHeader}>Contacts ({sortedContacts.length})</h3>
            <div className={styles.list}>
              {sortedContacts.map((contact) => {
                const touchDays = daysSince(contact.lastTouchpoint)
                const warmthClass = touchDays == null
                  ? styles.warmthUnknown
                  : touchDays < 14
                      ? styles.warmthGreen
                      : touchDays <= 30
                          ? styles.warmthYellow
                          : styles.warmthRed
                return (
                  <button
                    key={contact.id}
                    className={styles.card}
                    onClick={() => navigate(`/contact/${contact.id}`)}
                  >
                    <div className={styles.cardRow}>
                      <span className={styles.cardName}>{contact.fullName}</span>
                      <span className={styles.cardEmail}>{contact.email || ''}</span>
                    </div>
                    <div className={styles.cardRow}>
                      <span className={styles.cardMeta}>
                        {[
                          contact.title || null,
                          contact.meetingCount > 0 ? `${contact.meetingCount} meeting${contact.meetingCount === 1 ? '' : 's'}` : null,
                          contact.emailCount > 0 ? `${contact.emailCount} email${contact.emailCount === 1 ? '' : 's'}` : null
                        ].filter(Boolean).join(' · ') || 'No activity'}
                      </span>
                      <div className={styles.touchMeta}>
                        <span className={styles.cardDate}>
                          {formatDate(contact.lastTouchpoint || contact.updatedAt)}
                        </span>
                        <span className={`${styles.warmthBadge} ${warmthClass}`}>
                          {touchDays == null ? '--' : `${touchDays}d`}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {!loading && sortedContacts.length === 0 && query && (
          <p className={styles.noResults}>No contacts match your search.</p>
        )}
      </div>

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
