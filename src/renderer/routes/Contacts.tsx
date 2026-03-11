import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { createPortal } from 'react-dom'
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
  ContactEnrichmentOptions,
  ContactDedupAction,
  ContactDedupApplyResult,
  ContactDedupDecision,
  ContactDuplicateGroup
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

function formatDateTime(value: string | null | undefined): string {
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return '--'
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function dedupActionLabel(action: ContactDedupAction): string {
  if (action === 'delete') return 'Delete extras'
  if (action === 'merge') return 'Merge into keep'
  return 'Skip'
}

function normalizeEmailInput(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^mailto:/, '')
  if (!cleaned) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

function splitNameForEditing(fullName: string): { firstName: string; lastName: string } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return { firstName: '', lastName: '' }
  }
  if (tokens.length === 1) {
    return { firstName: tokens[0], lastName: '' }
  }
  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1]
  }
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
  const [dedupResult, setDedupResult] = useState<ContactDedupApplyResult | null>(null)
  const [newFirstName, setNewFirstName] = useState('')
  const [newLastName, setNewLastName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newContactType, setNewContactType] = useState('')
  const [newLinkedinUrl, setNewLinkedinUrl] = useState('')
  const [newCompanyName, setNewCompanyName] = useState('')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [applyingDedup, setApplyingDedup] = useState(false)
  const [dedupGroups, setDedupGroups] = useState<ContactDuplicateGroup[] | null>(null)
  const [dedupActionsByGroup, setDedupActionsByGroup] = useState<Record<string, ContactDedupAction>>({})
  const [dedupKeepByGroup, setDedupKeepByGroup] = useState<Record<string, string>>({})
  const [dedupSelectedByGroup, setDedupSelectedByGroup] = useState<Record<string, string[]>>({})
  const [editingDedupContactId, setEditingDedupContactId] = useState<string | null>(null)
  const [dedupEditFirstName, setDedupEditFirstName] = useState('')
  const [dedupEditLastName, setDedupEditLastName] = useState('')
  const [dedupEditEmail, setDedupEditEmail] = useState('')
  const [dedupEditCompany, setDedupEditCompany] = useState('')
  const [savingDedupContact, setSavingDedupContact] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const bulkMenuRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const createCardRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
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
          limit: 5000,
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

  const reviewDuplicates = useCallback(async (triggeredByRun = false) => {
    if (!contactsEnabled) return
    setCheckingDuplicates(true)
    try {
      const groups = await window.api.invoke<ContactDuplicateGroup[]>(
        IPC_CHANNELS.CONTACT_DEDUP_SUSPECTED,
        40
      )
      if (!groups || groups.length === 0) {
        setDedupGroups(null)
        setDedupSelectedByGroup({})
        setEditingDedupContactId(null)
        if (!triggeredByRun) {
          setDedupResult({
            reviewedGroups: 0,
            mergedGroups: 0,
            deletedGroups: 0,
            skippedGroups: 0,
            mergedContacts: 0,
            deletedContacts: 0,
            failures: []
          })
        }
        return
      }

      const sortedGroups = [...groups].sort((a, b) => {
        const aKey = normalizeSortKey(a.normalizedName || a.reason || a.key)
        const bKey = normalizeSortKey(b.normalizedName || b.reason || b.key)
        if (aKey !== bKey) return aKey.localeCompare(bKey)
        return a.key.localeCompare(b.key)
      })

      setDedupGroups(sortedGroups)
      setDedupActionsByGroup((prev) => {
        const next: Record<string, ContactDedupAction> = {}
        for (const group of sortedGroups) {
          next[group.key] = prev[group.key] || 'skip'
        }
        return next
      })
      setDedupKeepByGroup((prev) => {
        const next: Record<string, string> = {}
        for (const group of sortedGroups) {
          const preferred = prev[group.key] || group.suggestedKeepContactId
          const valid = group.contacts.some((contact) => contact.id === preferred)
          next[group.key] = valid ? preferred : group.suggestedKeepContactId
        }
        return next
      })
      setDedupSelectedByGroup((prev) => {
        const next: Record<string, string[]> = {}
        for (const group of sortedGroups) {
          const validIds = new Set(group.contacts.map((contact) => contact.id))
          const current = (prev[group.key] || [])
            .filter((id) => validIds.has(id))
          next[group.key] = current
        }
        return next
      })
    } catch (err) {
      setError(String(err))
    } finally {
      setCheckingDuplicates(false)
    }
  }, [contactsEnabled])

  const closeDedupDialog = useCallback(() => {
    if (applyingDedup || savingDedupContact) return
    setDedupGroups(null)
    setDedupSelectedByGroup({})
    setEditingDedupContactId(null)
    setDedupEditFirstName('')
    setDedupEditLastName('')
    setDedupEditEmail('')
    setDedupEditCompany('')
  }, [applyingDedup, savingDedupContact])

  const startDedupContactEdit = useCallback((
    contact: ContactDuplicateGroup['contacts'][number]
  ) => {
    const { firstName, lastName } = splitNameForEditing(contact.fullName)
    setError(null)
    setEditingDedupContactId(contact.id)
    setDedupEditFirstName(firstName)
    setDedupEditLastName(lastName)
    setDedupEditEmail(contact.email || '')
    setDedupEditCompany(contact.primaryCompanyName || '')
  }, [])

  const cancelDedupContactEdit = useCallback(() => {
    if (savingDedupContact) return
    setError(null)
    setEditingDedupContactId(null)
    setDedupEditFirstName('')
    setDedupEditLastName('')
    setDedupEditEmail('')
    setDedupEditCompany('')
  }, [savingDedupContact])

  const saveDedupContactEdit = useCallback(async () => {
    if (!editingDedupContactId || savingDedupContact) return
    const nextFirstName = dedupEditFirstName.trim()
    const nextLastName = dedupEditLastName.trim()
    if (!nextFirstName && !nextLastName) {
      setError('First name or last name is required')
      return
    }

    const rawEmail = dedupEditEmail.trim()
    const normalizedEmail = rawEmail ? normalizeEmailInput(rawEmail) : null
    if (rawEmail && !normalizedEmail) {
      setError('Primary contact email must be valid')
      return
    }

    setSavingDedupContact(true)
    setError(null)
    try {
      await window.api.invoke(
        IPC_CHANNELS.CONTACT_UPDATE,
        editingDedupContactId,
        {
          firstName: nextFirstName || null,
          lastName: nextLastName || null,
          email: normalizedEmail
        }
      )

      const nextCompany = dedupEditCompany.trim()
      if (nextCompany) {
        await window.api.invoke(
          IPC_CHANNELS.CONTACT_SET_COMPANY,
          editingDedupContactId,
          nextCompany
        )
      }

      setEditingDedupContactId(null)
      setDedupEditFirstName('')
      setDedupEditLastName('')
      setDedupEditEmail('')
      setDedupEditCompany('')

      await loadContacts(query)
      await reviewDuplicates(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSavingDedupContact(false)
    }
  }, [
    dedupEditCompany,
    dedupEditEmail,
    dedupEditFirstName,
    dedupEditLastName,
    editingDedupContactId,
    loadContacts,
    query,
    reviewDuplicates,
    savingDedupContact
  ])

  const applyDedupActions = useCallback(async () => {
    if (!dedupGroups || dedupGroups.length === 0) return
    setApplyingDedup(true)
    setError(null)
    try {
      const decisions: ContactDedupDecision[] = dedupGroups.map((group) => {
        const validContactIds = new Set(group.contacts.map((contact) => contact.id))
        const selectedContactIds = (dedupSelectedByGroup[group.key] || [])
          .filter((id) => validContactIds.has(id))
        const action = dedupActionsByGroup[group.key] || 'skip'
        const keepPreference = dedupKeepByGroup[group.key] || group.suggestedKeepContactId
        const keepContactId = selectedContactIds.includes(keepPreference)
          ? keepPreference
          : (selectedContactIds[0] || group.suggestedKeepContactId)
        const contactIds = selectedContactIds.includes(keepContactId)
          ? selectedContactIds
          : [keepContactId, ...selectedContactIds]
        if (action !== 'skip' && contactIds.length < 2) {
          throw new Error(`Select at least two contacts for "${group.reason}" or set action to Skip`)
        }
        return {
          groupKey: group.key,
          action,
          keepContactId,
          contactIds
        }
      })

      const result = await window.api.invoke<ContactDedupApplyResult>(
        IPC_CHANNELS.CONTACT_DEDUP_APPLY,
        decisions
      )
      setDedupResult(result)
      setDedupGroups(null)
      setDedupSelectedByGroup({})
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    } finally {
      setApplyingDedup(false)
    }
  }, [dedupActionsByGroup, dedupGroups, dedupKeepByGroup, dedupSelectedByGroup, loadContacts, query])

  const syncContacts = useCallback(async () => {
    if (!contactsEnabled) return
    setSyncing(true)
    setError(null)
    setEnrichmentResult(null)
    setDedupResult(null)
    try {
      const result = await window.api.invoke<ContactSyncResult>(
        IPC_CHANNELS.CONTACT_SYNC_FROM_MEETINGS
      )
      setSyncResult(result)
      await loadContacts(query)
      await reviewDuplicates(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setSyncing(false)
    }
  }, [contactsEnabled, loadContacts, query, reviewDuplicates])

  const enrichContacts = useCallback(async (webLookup = false) => {
    if (!contactsEnabled) return
    setEnriching(true)
    setError(null)
    setDedupResult(null)
    try {
      const options: ContactEnrichmentOptions | undefined = webLookup
        ? { webLookup: true }
        : undefined
      const result = await window.api.invoke<ContactEnrichmentResult>(
        IPC_CHANNELS.CONTACT_ENRICH_EXISTING,
        options
      )
      setEnrichmentResult(result)
      await loadContacts(query)
      await reviewDuplicates(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setEnriching(false)
    }
  }, [contactsEnabled, loadContacts, query, reviewDuplicates])

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

  useEffect(() => {
    if (!bulkMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target as Node)) {
        setBulkMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [bulkMenuOpen])

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0 || bulkDeleting) return
    setBulkMenuOpen(false)
    setBulkDeleting(true)
    setError(null)
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) =>
          window.api.invoke(IPC_CHANNELS.CONTACT_DELETE, id)
        )
      )
      setSelectedIds(new Set())
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    } finally {
      setBulkDeleting(false)
    }
  }, [selectedIds, bulkDeleting, loadContacts, query])

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

  const virtualizer = useVirtualizer({
    count: sortedContacts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 5
  })
  const dedupActionableGroups = dedupGroups
    ? dedupGroups.filter((group) => {
      const action = dedupActionsByGroup[group.key] || 'skip'
      if (action === 'skip') return false
      const validContactIds = new Set(group.contacts.map((contact) => contact.id))
      const selectedContactIds = (dedupSelectedByGroup[group.key] || [])
        .filter((id) => validContactIds.has(id))
      return selectedContactIds.length >= 2
    }).length
    : 0
  const dedupIncompleteGroups = dedupGroups
    ? dedupGroups.filter((group) => {
      const action = dedupActionsByGroup[group.key] || 'skip'
      if (action === 'skip') return false
      const validContactIds = new Set(group.contacts.map((contact) => contact.id))
      const selectedContactIds = (dedupSelectedByGroup[group.key] || [])
        .filter((id) => validContactIds.has(id))
      return selectedContactIds.length < 2
    }).length
    : 0
  const dedupEditActive = Boolean(editingDedupContactId) || savingDedupContact

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
      {dedupResult && (
        <span className={styles.syncMeta}>
          De-dup reviewed: {dedupResult.reviewedGroups} groups, merged: {dedupResult.mergedGroups} ({dedupResult.mergedContacts} contacts), deleted: {dedupResult.deletedGroups} ({dedupResult.deletedContacts} contacts), skipped: {dedupResult.skippedGroups}
          {dedupResult.failures.length > 0 ? `, failures: ${dedupResult.failures.length}` : ''}
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
          <div className={styles.actionsDropdown} ref={actionsRef}>
            <button
              className={styles.actionsBtn}
              onClick={() => setActionsOpen((v) => !v)}
              disabled={checkingDuplicates || applyingDedup}
            >
              Actions &#9662;
            </button>
            {actionsOpen && (
              <div className={styles.actionsMenu}>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { syncContacts(); setActionsOpen(false) }}
                  disabled={syncing || enriching || checkingDuplicates || applyingDedup}
                >
                  {syncing ? 'Syncing...' : 'Sync from Meetings'}
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void enrichContacts(); setActionsOpen(false) }}
                  disabled={syncing || enriching || checkingDuplicates || applyingDedup}
                >
                  {enriching ? 'Enriching...' : 'Enrich Contacts'}
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void enrichContacts(true); setActionsOpen(false) }}
                  disabled={syncing || enriching || checkingDuplicates || applyingDedup}
                >
                  Enrich with Web Lookup
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void reviewDuplicates(false); setActionsOpen(false) }}
                  disabled={syncing || enriching || checkingDuplicates || applyingDedup}
                >
                  {checkingDuplicates ? 'Checking...' : 'Review Duplicates'}
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

      <div className={styles.scrollArea} ref={scrollRef}>
        {showEmptyState ? (
          <EmptyState
            title="No contacts yet"
            description="Contacts are synced from meeting attendees. Click 'Sync from meetings' to populate."
            action={{ label: '+ New Contact', onClick: openCreateForm }}
          />
        ) : (
          <div className={styles.section}>
            <h3 className={styles.sectionHeader}>Contacts ({sortedContacts.length})</h3>
            <div className={styles.list} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vrow) => {
                const contact = sortedContacts[vrow.index]
                const touchDays = daysSince(contact.lastTouchpoint)
                const warmthClass = touchDays == null
                  ? styles.warmthUnknown
                  : touchDays < 14
                      ? styles.warmthGreen
                      : touchDays <= 30
                          ? styles.warmthYellow
                          : styles.warmthRed
                const isSelected = selectedIds.has(contact.id)
                return (
                  <div
                    key={contact.id}
                    style={{ position: 'absolute', top: vrow.start, left: 0, right: 0 }}
                    className={`${styles.cardWrapper} ${isSelected ? styles.cardWrapperSelected : ''}`}
                  >
                    <div
                      className={styles.checkboxZone}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(contact.id)) next.delete(contact.id)
                          else next.add(contact.id)
                          return next
                        })
                      }}
                    >
                      <input
                        type="checkbox"
                        className={styles.contactCheckbox}
                        checked={isSelected}
                        onChange={() => {}}
                        tabIndex={-1}
                      />
                    </div>
                    <button
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
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {!loading && sortedContacts.length === 0 && query && (
          <p className={styles.noResults}>No contacts match your search.</p>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className={styles.bulkBar}>
          <button
            className={styles.bulkClear}
            onClick={() => setSelectedIds(new Set())}
            aria-label="Clear selection"
          >
            {selectedIds.size} selected ✕
          </button>
          <div className={styles.bulkMenuWrap} ref={bulkMenuRef}>
            <button
              className={styles.bulkMenuBtn}
              onClick={() => setBulkMenuOpen((v) => !v)}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? 'Working…' : 'Actions ▾'}
            </button>
            {bulkMenuOpen && (
              <div className={styles.bulkMenu}>
                <button
                  className={`${styles.bulkMenuItem} ${styles.bulkMenuItemDanger}`}
                  onClick={() => void handleBulkDelete()}
                  disabled={bulkDeleting}
                >
                  Delete {selectedIds.size} contact{selectedIds.size !== 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {dedupGroups && createPortal(
        <div className={styles.dedupOverlay} onClick={closeDedupDialog}>
          <div className={styles.dedupDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.dedupHeader}>
              <h3 className={styles.dedupTitle}>Review Suspected Duplicates</h3>
              <button
                className={styles.dedupCloseButton}
                onClick={closeDedupDialog}
                type="button"
                disabled={applyingDedup || savingDedupContact}
              >
                Close
              </button>
            </div>
            <p className={styles.dedupSubtitle}>
              Check the contacts to include for each action, then choose which checked contact to keep. Saving an edit recalculates duplicate matches, and contacts that no longer match disappear from this list.
            </p>
            <div className={styles.dedupTableWrap}>
              <table className={styles.dedupTable}>
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Contacts</th>
                    <th>Action</th>
                    <th>Keep</th>
                  </tr>
                </thead>
                <tbody>
                  {dedupGroups.map((group) => {
                    const selectedAction = dedupActionsByGroup[group.key] || 'skip'
                    const validContactIds = new Set(group.contacts.map((contact) => contact.id))
                    const selectedContactIds = (dedupSelectedByGroup[group.key] || [])
                      .filter((id) => validContactIds.has(id))
                    const normalizedSelectedContactIds = selectedContactIds
                    const keepPreference = dedupKeepByGroup[group.key] || group.suggestedKeepContactId
                    const selectedKeep = normalizedSelectedContactIds.includes(keepPreference)
                      ? keepPreference
                      : (normalizedSelectedContactIds[0] || group.suggestedKeepContactId)
                    const keepOptions = group.contacts.filter((contact) =>
                      normalizedSelectedContactIds.includes(contact.id)
                    )

                    return (
                      <tr key={group.key}>
                        <td>
                          <div className={styles.dedupReason}>{group.reason}</div>
                          <div className={styles.dedupReasonMeta}>
                            {group.contacts.length} contacts · {normalizedSelectedContactIds.length} selected
                          </div>
                        </td>
                        <td>
                          <div className={styles.dedupContactList}>
                            {group.contacts.map((contact) => (
                              <div key={contact.id} className={styles.dedupContactItem}>
                                {editingDedupContactId === contact.id ? (
                                  <>
                                    <div className={styles.dedupContactRow}>
                                      <label className={styles.dedupContactSelect}>
                                        <input
                                          type="checkbox"
                                          className={styles.dedupContactCheckbox}
                                          checked={normalizedSelectedContactIds.includes(contact.id)}
                                          onChange={(e) => {
                                            const checked = e.target.checked
                                            setDedupSelectedByGroup((prev) => {
                                              const groupContactIds = group.contacts.map((entry) => entry.id)
                                              const current = (prev[group.key] || [])
                                                .filter((id) => groupContactIds.includes(id))
                                              if (checked) {
                                                if (current.includes(contact.id)) {
                                                  return {
                                                    ...prev,
                                                    [group.key]: current
                                                  }
                                                }
                                                return {
                                                  ...prev,
                                                  [group.key]: [...current, contact.id]
                                                }
                                              }
                                              return {
                                                ...prev,
                                                [group.key]: current.filter((id) => id !== contact.id)
                                              }
                                            })
                                          }}
                                          disabled={applyingDedup || savingDedupContact}
                                        />
                                        <span className={styles.dedupContactName}>{contact.fullName}</span>
                                      </label>
                                    </div>
                                    <div className={styles.dedupContactEditor}>
                                      <input
                                        className={styles.dedupContactInput}
                                        value={dedupEditFirstName}
                                        onChange={(e) => setDedupEditFirstName(e.target.value)}
                                        placeholder="First name"
                                        disabled={savingDedupContact}
                                      />
                                      <input
                                        className={styles.dedupContactInput}
                                        value={dedupEditLastName}
                                        onChange={(e) => setDedupEditLastName(e.target.value)}
                                        placeholder="Last name"
                                        disabled={savingDedupContact}
                                      />
                                      <input
                                        className={styles.dedupContactInput}
                                        value={dedupEditEmail}
                                        onChange={(e) => setDedupEditEmail(e.target.value)}
                                        placeholder="Primary email"
                                        disabled={savingDedupContact}
                                      />
                                      <input
                                        className={styles.dedupContactInput}
                                        value={dedupEditCompany}
                                        onChange={(e) => setDedupEditCompany(e.target.value)}
                                        placeholder="Company"
                                        disabled={savingDedupContact}
                                      />
                                      <div className={styles.dedupContactEditorActions}>
                                        <button
                                          className={styles.dedupContactEditButton}
                                          type="button"
                                          onClick={() => void saveDedupContactEdit()}
                                          disabled={savingDedupContact}
                                        >
                                          {savingDedupContact ? 'Saving...' : 'Save'}
                                        </button>
                                        <button
                                          className={styles.dedupContactEditButton}
                                          type="button"
                                          onClick={cancelDedupContactEdit}
                                          disabled={savingDedupContact}
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div className={styles.dedupContactRow}>
                                      <label className={styles.dedupContactSelect}>
                                        <input
                                          type="checkbox"
                                          className={styles.dedupContactCheckbox}
                                          checked={normalizedSelectedContactIds.includes(contact.id)}
                                          onChange={(e) => {
                                            const checked = e.target.checked
                                            setDedupSelectedByGroup((prev) => {
                                              const groupContactIds = group.contacts.map((entry) => entry.id)
                                              const current = (prev[group.key] || [])
                                                .filter((id) => groupContactIds.includes(id))
                                              if (checked) {
                                                if (current.includes(contact.id)) {
                                                  return {
                                                    ...prev,
                                                    [group.key]: current
                                                  }
                                                }
                                                return {
                                                  ...prev,
                                                  [group.key]: [...current, contact.id]
                                                }
                                              }
                                              return {
                                                ...prev,
                                                [group.key]: current.filter((id) => id !== contact.id)
                                              }
                                            })
                                          }}
                                          disabled={applyingDedup || savingDedupContact}
                                        />
                                        <span className={styles.dedupContactName}>{contact.fullName}</span>
                                      </label>
                                      <button
                                        className={styles.dedupContactEditButton}
                                        type="button"
                                        onClick={() => startDedupContactEdit(contact)}
                                        disabled={
                                          applyingDedup
                                          || savingDedupContact
                                          || (editingDedupContactId !== null && editingDedupContactId !== contact.id)
                                        }
                                      >
                                        Edit
                                      </button>
                                    </div>
                                    <span className={styles.dedupContactMeta}>
                                      {[contact.email, contact.primaryCompanyName, formatDateTime(contact.updatedAt)]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </span>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <select
                            className={styles.dedupSelect}
                            value={selectedAction}
                            onChange={(e) => {
                              const action = e.target.value as ContactDedupAction
                              setDedupActionsByGroup((prev) => ({
                                ...prev,
                                [group.key]: action
                              }))
                            }}
                            disabled={applyingDedup || dedupEditActive}
                          >
                            <option value="skip">{dedupActionLabel('skip')}</option>
                            <option value="delete">{dedupActionLabel('delete')}</option>
                            <option value="merge">{dedupActionLabel('merge')}</option>
                          </select>
                        </td>
                        <td>
                          <select
                            className={styles.dedupSelect}
                            value={selectedKeep}
                            onChange={(e) => {
                              setDedupKeepByGroup((prev) => ({
                                ...prev,
                                [group.key]: e.target.value
                              }))
                            }}
                            disabled={applyingDedup || dedupEditActive || selectedAction === 'skip' || keepOptions.length === 0}
                          >
                            {keepOptions.map((contact) => (
                              <option key={contact.id} value={contact.id}>
                                {contact.fullName}{contact.email ? ` (${contact.email})` : ''}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.dedupFooter}>
              <span className={styles.dedupSummary}>
                {dedupActionableGroups} group{dedupActionableGroups === 1 ? '' : 's'} ready
                {dedupIncompleteGroups > 0 ? ` · ${dedupIncompleteGroups} incomplete` : ''}
              </span>
              <div className={styles.dedupActions}>
                <button
                  className={styles.dedupCancelButton}
                  onClick={closeDedupDialog}
                  type="button"
                  disabled={applyingDedup || savingDedupContact}
                >
                  Cancel
                </button>
                <button
                  className={styles.dedupApplyButton}
                  onClick={() => void applyDedupActions()}
                  type="button"
                  disabled={applyingDedup || dedupEditActive || dedupActionableGroups === 0 || dedupIncompleteGroups > 0}
                >
                  {applyingDedup ? 'Applying...' : 'Apply Actions'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
