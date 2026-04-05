import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import ChatInterface from '../components/chat/ChatInterface'
import { ContactTable } from '../components/contact/ContactTable'
import { ViewsBar } from '../components/crm/ViewsBar'
import { CreateCustomFieldModal } from '../components/crm/CreateCustomFieldModal'
import {
  CONTACT_COLUMN_DEFS,
  CONTACT_GROUPABLE_FIELDS,
  CONTACT_SCOPE_LABELS,
  CONTACT_SCOPE_TO_TYPE,
  loadContactColumnConfig,
  saveContactColumnConfig,
  filterContacts,
  type ContactScope
} from '../components/contact/contactColumns'
import { useGroupedRows } from '../hooks/useGroupedRows'
import { GroupByPicker } from '../components/crm/GroupByPicker'
import { SmartFilters } from '../components/crm/SmartFilters'
import type { FilterPreset } from '../components/crm/SmartFilters'
import type {
  ContactSummary,
  ContactSyncResult,
  ContactEnrichmentResult,
  ContactEnrichmentOptions,
  ContactDedupAction,
  ContactDedupApplyResult,
  ContactDedupDecision,
  ContactDuplicateGroup
} from '../../shared/types/contact'
import { sortRows, buildCustomFieldColumnDefs } from '../components/crm/tableUtils'
import type { SortState, SortKey } from '../components/crm/tableUtils'
import { useTableFilters } from '../hooks/useTableFilters'
import { useCustomFieldValues } from '../hooks/useCustomFieldValues'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import type { CustomFieldDefinition } from '../../shared/types/custom-fields'
import styles from './Contacts.module.css'
import { api } from '../api'
import { selectMergeKeepId } from '../utils/contactMerge'

// ─── Helpers (dedup dialog only) ──────────────────────────────────────────────

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

  if (tokens.length === 0) return { firstName: '', lastName: '' }
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' }
  return {
    firstName: tokens.slice(0, -1).join(' '),
    lastName: tokens[tokens.length - 1]
  }
}

function normalizeSortKey(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

// Maps ColumnDef.field → URL param name for backwards-compat with existing saved views.
// Must be a stable module-level const (passed to useTableFilters as fieldToParamMap).
const CONTACT_FIELD_TO_PARAM: Record<string, string> = { contactType: 'type' }

// ─── Smart filter presets ──────────────────────────────────────────────────────
const get30DaysAgo = () => {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}
const getStartOfWeek = () => {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  return d.toISOString().slice(0, 10)
}

const CONTACT_PRESETS: FilterPreset[] = [
  {
    id: 'no-touch-30',
    label: 'No touch in 30 days',
    getParams: () => ({ lastTouchpoint_max: get30DaysAgo() }),
    paramKeys: ['lastTouchpoint_max']
  },
  {
    id: 'added-this-week',
    label: 'Added this week',
    getParams: () => ({ createdAt_min: getStartOfWeek() }),
    paramKeys: ['createdAt_min']
  }
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function Contacts() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: contactsEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')

  // ── Data ──────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Sync / enrich ─────────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [syncResult, setSyncResult] = useState<ContactSyncResult | null>(null)
  const [enrichmentResult, setEnrichmentResult] = useState<ContactEnrichmentResult | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)

  // ── Create form ───────────────────────────────────────────────────────────
  const [newFirstName, setNewFirstName] = useState('')
  const [newLastName, setNewLastName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newContactType, setNewContactType] = useState('')
  const [newLinkedinUrl, setNewLinkedinUrl] = useState('')
  const [newCompanyName, setNewCompanyName] = useState('')
  const createCardRef = useRef<HTMLDivElement>(null)

  // ── Dedup ─────────────────────────────────────────────────────────────────
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
  const [dedupResult, setDedupResult] = useState<ContactDedupApplyResult | null>(null)

  // ── Manual merge ──────────────────────────────────────────────────────────
  const [tableSelectedIds, setTableSelectedIds] = useState<Set<string>>(new Set())
  const [mergeDialogContacts, setMergeDialogContacts] = useState<ContactSummary[] | null>(null)
  const [mergeKeepId, setMergeKeepId] = useState<string | null>(null)
  const [mergingContacts, setMergingContacts] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeSuccessMessage, setMergeSuccessMessage] = useState<string | null>(null)
  const [mergeCount, setMergeCount] = useState(0)

  // ── Columns + sort + filter (lifted for ViewsBar) ─────────────────────────
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => loadContactColumnConfig())

  // ── Custom fields ───────────────────────────────────────────────────────────
  const { contactDefs, refresh: refreshCustomFields } = useCustomFieldStore()
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('cyggie:column-label-overrides:contact') ?? '{}') }
    catch { return {} }
  })
  const allDefs = useMemo(() => {
    const customDefs = buildCustomFieldColumnDefs(contactDefs)
    return [...CONTACT_COLUMN_DEFS, ...customDefs].map((d) => ({
      ...d,
      label: labelOverrides[d.key] ?? d.label
    }))
  }, [contactDefs, labelOverrides])

  const { values: customFieldValues, patch: patchCustomField } = useCustomFieldValues(
    'contact', visibleKeys, contacts.length
  )

  const [createFieldOpen, setCreateFieldOpen] = useState(false)

  async function handleRenameColumn(key: string, label: string) {
    if (key.startsWith('custom:')) {
      const r = await api.invoke<{ success: boolean; message?: string }>(
        IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, key.slice(7), { label }
      )
      if (!r.success) {
        console.warn('[rename] CUSTOM_FIELD_UPDATE_DEFINITION failed', r.message)
        return
      }
      await refreshCustomFields()
    } else {
      const next = { ...labelOverrides, [key]: label }
      setLabelOverrides(next)
      localStorage.setItem('cyggie:column-label-overrides:contact', JSON.stringify(next))
    }
  }

  async function handleFieldCreated(def: CustomFieldDefinition) {
    await refreshCustomFields()
    const newKey = `custom:${def.id}`
    const next = [...visibleKeys, newKey]
    setVisibleKeys(next)
    saveContactColumnConfig(next)
    setCreateFieldOpen(false)
  }

  const sort = useMemo<SortState>(() => {
    const raw = searchParams.get('sort')
    if (raw) {
      const parsed = raw.split(',').filter(p => p.includes(':')).map(p => {
        const [key, d] = p.split(':')
        return { key, dir: d === 'asc' ? 'asc' : 'desc' } as SortKey
      })
      if (parsed.length > 0) return parsed
    }
    // Legacy fallback — preserves existing saved views
    return [{
      key: searchParams.get('sortKey') || 'name',
      dir: (searchParams.get('sortDir') || 'asc') as 'asc' | 'desc'
    }]
  }, [searchParams])

  // ── Grouping ──────────────────────────────────────────────────────────────
  const groupBy = searchParams.get('groupBy') || null
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // ── Scope tabs ────────────────────────────────────────────────────────────
  const scope = (searchParams.get('scope') || 'all') as ContactScope

  // ── Column / range / text filters — URL-driven via shared hook ──────────────
  const {
    columnFilters, rangeFilters, textFilters, activeFilterCount,
    handleColumnFilter, handleRangeFilter, handleTextFilter, clearAllFilters
  } = useTableFilters({ columnDefs: CONTACT_COLUMN_DEFS, searchParams, setSearchParams, fieldToParamMap: CONTACT_FIELD_TO_PARAM })

  // ── URL param helpers ─────────────────────────────────────────────────────
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'

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

  const handleSort = useCallback((key: string, shiftHeld: boolean) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      const existing = sort.findIndex((s) => s.key === key)
      let newSort: SortKey[]
      if (shiftHeld) {
        newSort = existing >= 0 ? sort.filter(s => s.key !== key) : [...sort, { key, dir: 'asc' }]
      } else {
        if (existing >= 0) {
          const prevDir = sort[existing].dir
          newSort = [{ key, dir: prevDir === 'asc' ? 'desc' : 'asc' }]
        } else {
          newSort = [{ key, dir: 'asc' }]
        }
      }
      if (newSort.length === 0) newSort = [{ key: 'name', dir: 'asc' }]
      next.set('sort', newSort.map(s => `${s.key}:${s.dir}`).join(','))
      next.delete('sortKey')
      next.delete('sortDir')
      return next
    })
  }, [setSearchParams, sort])

  const handleSetGroupBy = useCallback((key: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key) { next.set('groupBy', key) } else { next.delete('groupBy') }
      return next
    })
    setCollapsedGroups(new Set())
  }, [setSearchParams])

  const handleToggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) { next.delete(groupKey) } else { next.add(groupKey) }
      return next
    })
  }, [])

  const handleHideColumn = useCallback((key: string) => {
    const next = visibleKeys.filter(k => k !== key)
    setVisibleKeys(next)
    saveContactColumnConfig(next)
  }, [visibleKeys])

  const handleDeleteColumn = useCallback(async (key: string) => {
    if (!key.startsWith('custom:')) return
    const r = await api.invoke<{ success: boolean }>(IPC_CHANNELS.CUSTOM_FIELD_DELETE_DEFINITION, key.slice(7))
    if (!r.success) { console.warn('[deleteColumn] failed'); return }
    const next = visibleKeys.filter(k => k !== key)
    setVisibleKeys(next)
    saveContactColumnConfig(next)
    await refreshCustomFields()
  }, [visibleKeys, refreshCustomFields])

  const handleSetScope = useCallback((s: ContactScope) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (s === 'all') { next.delete('scope') } else { next.set('scope', s) }
      return next
    })
  }, [setSearchParams])

  // ── Data load ─────────────────────────────────────────────────────────────
  const loadContacts = useCallback(async (searchQuery: string) => {
    if (!contactsEnabled) return
    setLoading(true)
    setError(null)
    try {
      const results = await api.invoke<ContactSummary[]>(
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

  const handleCreateInline = useCallback(async (fullName: string) => {
    const tokens = fullName.trim().split(/\s+/)
    const firstName = tokens.slice(0, -1).join(' ') || tokens[0] || ''
    const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : ''
    try {
      const created = await api.invoke<ContactSummary>(IPC_CHANNELS.CONTACT_CREATE, {
        fullName: fullName.trim(),
        firstName,
        lastName
      })
      await loadContacts(query)
      navigate(`/contact/${created.id}`)
    } catch (e) {
      console.error('[createInline] failed', e)
    }
  }, [loadContacts, query, navigate])

  // ── Dedup callbacks ───────────────────────────────────────────────────────
  const reviewDuplicates = useCallback(async (triggeredByRun = false) => {
    if (!contactsEnabled) return
    setCheckingDuplicates(true)
    try {
      const groups = await api.invoke<ContactDuplicateGroup[]>(
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
        for (const group of sortedGroups) next[group.key] = prev[group.key] || 'skip'
        return next
      })
      setDedupKeepByGroup((prev) => {
        const next: Record<string, string> = {}
        for (const group of sortedGroups) {
          const preferred = prev[group.key] || group.suggestedKeepContactId
          const valid = group.contacts.some((c) => c.id === preferred)
          next[group.key] = valid ? preferred : group.suggestedKeepContactId
        }
        return next
      })
      setDedupSelectedByGroup((prev) => {
        const next: Record<string, string[]> = {}
        for (const group of sortedGroups) {
          const validIds = new Set(group.contacts.map((c) => c.id))
          next[group.key] = (prev[group.key] || []).filter((id) => validIds.has(id))
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
      await api.invoke(
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
        await api.invoke(
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
        const validContactIds = new Set(group.contacts.map((c) => c.id))
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
        return { groupKey: group.key, action, keepContactId, contactIds }
      })

      const result = await api.invoke<ContactDedupApplyResult>(
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

  // ── Manual merge callbacks ────────────────────────────────────────────────
  const openMergeDialog = useCallback((ids: string[]) => {
    // Snapshot from full contacts array (not the filtered view) so selected
    // IDs are always resolvable even if a filter hides them after selection.
    const selected = contacts.filter((c) => ids.includes(c.id))
    if (selected.length < 2) return
    setMergeDialogContacts(selected)
    setMergeKeepId(selectMergeKeepId(selected))
    setMergeError(null)
    setMergeSuccessMessage(null)
  }, [contacts])

  const handleMerge = useCallback(async () => {
    if (!mergeDialogContacts || !mergeKeepId || mergingContacts) return
    setMergingContacts(true)
    setMergeError(null)
    try {
      const contactIds = mergeDialogContacts.map((c) => c.id)
      const groupKey = `manual:${[...contactIds].sort().join('-').slice(0, 50)}`
      const decision: ContactDedupDecision = {
        groupKey,
        action: 'merge',
        keepContactId: mergeKeepId,
        contactIds
      }
      const result = await api.invoke<ContactDedupApplyResult>(
        IPC_CHANNELS.CONTACT_DEDUP_APPLY,
        [decision]
      )
      if (result.failures.length > 0) {
        setMergeError(`Merge failed: ${result.failures[0].reason}`)
        return
      }
      const keptContact = mergeDialogContacts.find((c) => c.id === mergeKeepId)
      setMergeDialogContacts(null)
      setMergeCount((n) => n + 1)
      setMergeSuccessMessage(`Merged into ${keptContact?.fullName ?? 'contact'}`)
      try {
        await loadContacts(query)
      } catch {
        setError('Merge succeeded, but the contact list could not be refreshed. Please reload.')
      }
    } catch (err) {
      setMergeError(String(err))
    } finally {
      setMergingContacts(false)
    }
  }, [mergeDialogContacts, mergeKeepId, mergingContacts, loadContacts, query])

  // ── Sync / enrich callbacks ───────────────────────────────────────────────
  const syncContacts = useCallback(async () => {
    if (!contactsEnabled) return
    setSyncing(true)
    setError(null)
    setEnrichmentResult(null)
    setDedupResult(null)
    try {
      const result = await api.invoke<ContactSyncResult>(
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
      const options: ContactEnrichmentOptions | undefined = webLookup ? { webLookup: true } : undefined
      const result = await api.invoke<ContactEnrichmentResult>(
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

  // ── Create contact ────────────────────────────────────────────────────────
  const handleCreateContact = async () => {
    if (!newFirstName.trim() || !newLastName.trim()) return
    const fullName = `${newFirstName.trim()} ${newLastName.trim()}`
    try {
      const created = await api.invoke<ContactSummary>(
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

  // ── Patch + bulk delete (passed to ContactTable) ──────────────────────────
  const handlePatch = useCallback((id: string, patch: Record<string, unknown>) => {
    setContacts((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } as ContactSummary : c))
    )
    void api.invoke(IPC_CHANNELS.CONTACT_UPDATE, id, patch)
  }, [])

  const handleBulkDelete = useCallback(async (_ids: string[]) => {
    setError(null)
    try {
      await loadContacts(query)
    } catch (err) {
      setError(String(err))
    }
  }, [loadContacts, query])

  // ── Effects ───────────────────────────────────────────────────────────────
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!query) {
      void loadContacts('')
      return
    }
    searchDebounceRef.current = setTimeout(() => {
      void loadContacts(query)
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
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [actionsOpen])

  // ── Derived ───────────────────────────────────────────────────────────────
  const filteredContacts = useMemo(() => {
    let items = filterContacts(contacts, columnFilters, rangeFilters, textFilters) as ContactSummary[]
    const typeFilter = CONTACT_SCOPE_TO_TYPE[scope]
    if (typeFilter) items = items.filter(c => c.contactType === typeFilter)
    return sortRows(items as Record<string, unknown>[], sort, CONTACT_COLUMN_DEFS) as ContactSummary[]
  }, [contacts, columnFilters, rangeFilters, textFilters, sort, scope])

  const groupedRows = useGroupedRows(filteredContacts as Record<string, unknown>[], groupBy, CONTACT_GROUPABLE_FIELDS, collapsedGroups)

  const dedupEditActive = Boolean(editingDedupContactId) || savingDedupContact

  const dedupActionableGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action === 'skip') return false
        const validIds = new Set(group.contacts.map((c) => c.id))
        return ((dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))).length >= 2
      }).length
    : 0

  const dedupIncompleteGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action === 'skip') return false
        const validIds = new Set(group.contacts.map((c) => c.id))
        return ((dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))).length < 2
      }).length
    : 0

  const busy = syncing || enriching || checkingDuplicates || applyingDedup

  if (!flagsLoading && !contactsEnabled) {
    return (
      <EmptyState
        title="Contacts disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  return (
    <div className={styles.container}>
      {/* ── Status banners ── */}
      {syncResult && (
        <span className={styles.statusBanner}>
          {syncResult.inserted} new, {syncResult.updated} updated
        </span>
      )}
      {enrichmentResult && (
        <span className={styles.statusBanner}>
          Names: {enrichmentResult.updatedNames}, LinkedIn: {enrichmentResult.updatedLinkedinUrls},
          Titles: {enrichmentResult.updatedTitles}, Companies: {enrichmentResult.linkedCompanies}
          {enrichmentResult.webLookups > 0 ? `, Web lookups: ${enrichmentResult.webLookups}` : ''}
        </span>
      )}
      {dedupResult && (
        <span className={styles.statusBanner}>
          De-dup reviewed: {dedupResult.reviewedGroups} groups, merged: {dedupResult.mergedGroups}{' '}
          ({dedupResult.mergedContacts} contacts), deleted: {dedupResult.deletedGroups}{' '}
          ({dedupResult.deletedContacts} contacts), skipped: {dedupResult.skippedGroups}
          {dedupResult.failures.length > 0 ? `, failures: ${dedupResult.failures.length}` : ''}
        </span>
      )}
      {mergeSuccessMessage && (
        <span className={styles.statusBanner}>
          {mergeSuccessMessage}
          <button
            className={styles.statusBannerDismiss}
            onClick={() => setMergeSuccessMessage(null)}
            type="button"
          >
            ✕
          </button>
        </span>
      )}

      {/* ── Toolbar ── */}
      <div className={styles.toolbarRow}>
        <div className={styles.scopeRow}>
          {(Object.keys(CONTACT_SCOPE_LABELS) as ContactScope[]).map((s) => (
            <button
              key={s}
              className={`${styles.scopeButton} ${scope === s ? styles.activeScope : ''}`}
              onClick={() => handleSetScope(s)}
            >
              {CONTACT_SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        <div className={styles.headerActions}>
          <div className={styles.actionsDropdown} ref={actionsRef}>
            <button
              className={styles.actionsBtn}
              onClick={() => setActionsOpen((v) => !v)}
              disabled={busy}
            >
              Actions &#9662;
            </button>
            {actionsOpen && (
              <div className={styles.actionsMenu}>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void syncContacts(); setActionsOpen(false) }}
                  disabled={busy}
                >
                  {syncing ? 'Syncing...' : 'Sync from Meetings'}
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void enrichContacts(); setActionsOpen(false) }}
                  disabled={busy}
                >
                  {enriching ? 'Enriching...' : 'Enrich Contacts'}
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void enrichContacts(true); setActionsOpen(false) }}
                  disabled={busy}
                >
                  Enrich with Web Lookup
                </button>
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { void reviewDuplicates(false); setActionsOpen(false) }}
                  disabled={busy}
                >
                  {checkingDuplicates ? 'Checking...' : 'Review Duplicates'}
                </button>
                <div className={styles.actionsMenuSeparator} />
                <button
                  className={styles.actionsMenuItem}
                  onClick={() => { openMergeDialog(Array.from(tableSelectedIds)); setActionsOpen(false) }}
                  disabled={busy || tableSelectedIds.size < 2}
                >
                  {tableSelectedIds.size < 2 ? 'Merge Contacts (select 2+)' : `Merge ${tableSelectedIds.size} Contacts`}
                </button>
              </div>
            )}
          </div>
          <button className={styles.newBtn} onClick={openCreateForm}>
            + Contact
          </button>
        </div>
      </div>

      {/* ── Toolbar row 2: GroupBy + Clear sort + SmartFilters ── */}
      <div className={styles.toolbarRow2}>
        <GroupByPicker
          value={groupBy}
          fields={CONTACT_GROUPABLE_FIELDS}
          onChange={handleSetGroupBy}
        />
        {sort.length > 1 && (
          <button
            className={styles.clearSortBtn}
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev)
                next.set('sort', `${sort[0].key}:${sort[0].dir}`)
                return next
              })
            }}
          >
            Clear multi-sort
          </button>
        )}
        <SmartFilters
          presets={CONTACT_PRESETS}
          searchParams={searchParams}
          onApply={(params) => setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            Object.entries(params).forEach(([k, v]) => next.set(k, v))
            return next
          })}
          onClear={(keys) => setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            keys.forEach(k => next.delete(k))
            return next
          })}
        />
      </div>

      {/* ── Saved views bar ── */}
      <ViewsBar
        storageKey="cyggie:contact-views"
        currentParams={searchParams}
        currentColumns={visibleKeys}
        onApply={(params, columns) => {
          setSearchParams(params)
          setVisibleKeys(columns)
        }}
      />

      {/* ── Error ── */}
      {error && <div className={styles.error}>{error}</div>}

      {/* ── Create form ── */}
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
              onClick={() => void handleCreateContact()}
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

      {/* ── Filter chips ── */}
      {activeFilterCount > 0 && (
        <div className={styles.filterRow}>
          {/* Select filter chips */}
          {Object.entries(columnFilters).flatMap(([field, values]) => {
            const col = CONTACT_COLUMN_DEFS.find((c) => c.field === field)
            return values.map((v) => {
              const label = col?.options?.find((o) => o.value === v)?.label ?? v
              return (
                <span key={`${field}:${v}`} className={styles.filterChip}>
                  {col?.label ?? field}: {label}
                  <button
                    className={styles.filterChipX}
                    onClick={() => handleColumnFilter(field, (columnFilters[field] ?? []).filter((p) => p !== v))}
                  >
                    ×
                  </button>
                </span>
              )
            })
          })}
          {/* Range filter chips */}
          {Object.entries(rangeFilters).map(([field, { min, max }]) => {
            const col = CONTACT_COLUMN_DEFS.find((c) => c.field === field)
            const fmt = (v: string) =>
              col?.type === 'date'
                ? new Date(v + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                : `${col?.prefix ?? ''}${v}${col?.suffix ?? ''}`
            const rangeLabel =
              min && max && min === max ? `= ${fmt(min)}`
              : min && max ? `${fmt(min)} – ${fmt(max)}`
              : min ? `≥ ${fmt(min)}`
              : `≤ ${fmt(max!)}`
            return (
              <span key={`range:${field}`} className={styles.filterChip}>
                {col?.label ?? field}: {rangeLabel}
                <button className={styles.filterChipX} onClick={() => handleRangeFilter(field, {})}>
                  ×
                </button>
              </span>
            )
          })}
          {/* Text filter chips */}
          {Object.entries(textFilters).map(([field, value]) => {
            const col = CONTACT_COLUMN_DEFS.find((c) => c.field === field)
            return (
              <span key={`text:${field}`} className={styles.filterChip}>
                {col?.label ?? field}: &ldquo;{value}&rdquo;
                <button className={styles.filterChipX} onClick={() => handleTextFilter(field, '')}>
                  ×
                </button>
              </span>
            )
          })}
          <button className={styles.filterClearAll} onClick={clearAllFilters}>
            Clear all
          </button>
        </div>
      )}

      {/* ── Table ── */}
      {!flagsLoading && !loading && contacts.length === 0 && !query && !showCreate ? (
        <EmptyState
          title="No contacts yet"
          description="Contacts are synced from meeting attendees. Click 'Sync from Meetings' to populate."
          action={{ label: '+ New Contact', onClick: openCreateForm }}
        />
      ) : (
        <ContactTable
          contacts={filteredContacts}
          rows={groupedRows}
          groupBy={groupBy}
          onToggleGroup={handleToggleGroup}
          loading={loading}
          sort={sort}
          onSort={handleSort}
          onPatch={handlePatch}
          onBulkDelete={handleBulkDelete}
          onCreateInline={handleCreateInline}
          visibleKeys={visibleKeys}
          onVisibleKeysChange={setVisibleKeys}
          columnFilters={columnFilters}
          onColumnFilter={handleColumnFilter}
          rangeFilters={rangeFilters}
          onRangeFilter={handleRangeFilter}
          textFilters={textFilters}
          onTextFilter={handleTextFilter}
          allDefs={allDefs}
          customFieldValues={customFieldValues}
          onRenameColumn={handleRenameColumn}
          onHideColumn={handleHideColumn}
          onDeleteColumn={handleDeleteColumn}
          onCreateField={() => setCreateFieldOpen(true)}
          onPatchCustomField={patchCustomField}
          onSelectionChange={setTableSelectedIds}
          onMerge={(ids) => openMergeDialog(ids)}
          clearSelectionTrigger={mergeCount}
        />
      )}

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="contact"
          onSaved={(def) => void handleFieldCreated(def)}
          onClose={() => setCreateFieldOpen(false)}
        />
      )}

      {/* ── Dedup dialog ── */}
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
                    const validContactIds = new Set(group.contacts.map((c) => c.id))
                    const selectedContactIds = (dedupSelectedByGroup[group.key] || [])
                      .filter((id) => validContactIds.has(id))
                    const keepPreference = dedupKeepByGroup[group.key] || group.suggestedKeepContactId
                    const selectedKeep = selectedContactIds.includes(keepPreference)
                      ? keepPreference
                      : (selectedContactIds[0] || group.suggestedKeepContactId)
                    const keepOptions = group.contacts.filter((c) =>
                      selectedContactIds.includes(c.id)
                    )

                    return (
                      <tr key={group.key}>
                        <td>
                          <div className={styles.dedupReason}>
                            {group.reason}
                            {group.confidence != null && (
                              <span className={styles.confidenceBadge}>{group.confidence}% match</span>
                            )}
                          </div>
                          <div className={styles.dedupReasonMeta}>
                            {group.contacts.length} contacts · {selectedContactIds.length} selected
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
                                          checked={selectedContactIds.includes(contact.id)}
                                          onChange={(e) => {
                                            const checked = e.target.checked
                                            setDedupSelectedByGroup((prev) => {
                                              const groupIds = group.contacts.map((c) => c.id)
                                              const current = (prev[group.key] || []).filter((id) => groupIds.includes(id))
                                              if (checked) {
                                                return current.includes(contact.id)
                                                  ? { ...prev, [group.key]: current }
                                                  : { ...prev, [group.key]: [...current, contact.id] }
                                              }
                                              return { ...prev, [group.key]: current.filter((id) => id !== contact.id) }
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
                                          checked={selectedContactIds.includes(contact.id)}
                                          onChange={(e) => {
                                            const checked = e.target.checked
                                            setDedupSelectedByGroup((prev) => {
                                              const groupIds = group.contacts.map((c) => c.id)
                                              const current = (prev[group.key] || []).filter((id) => groupIds.includes(id))
                                              if (checked) {
                                                return current.includes(contact.id)
                                                  ? { ...prev, [group.key]: current }
                                                  : { ...prev, [group.key]: [...current, contact.id] }
                                              }
                                              return { ...prev, [group.key]: current.filter((id) => id !== contact.id) }
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
                              setDedupActionsByGroup((prev) => ({ ...prev, [group.key]: action }))
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
                              setDedupKeepByGroup((prev) => ({ ...prev, [group.key]: e.target.value }))
                            }}
                            disabled={applyingDedup || dedupEditActive || selectedAction === 'skip' || keepOptions.length === 0}
                          >
                            {keepOptions.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.fullName}{c.email ? ` (${c.email})` : ''}
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

      {/* ── Merge dialog ── */}
      {mergeDialogContacts && createPortal(
        <div className={styles.mergeOverlay} onClick={() => { if (!mergingContacts) setMergeDialogContacts(null) }}>
          <div className={styles.mergeDialog} onClick={(e) => e.stopPropagation()}>
            <div className={styles.mergeHeader}>
              <h3 className={styles.mergeTitle}>Merge Contacts</h3>
              <button
                className={styles.dedupCloseButton}
                onClick={() => setMergeDialogContacts(null)}
                type="button"
                disabled={mergingContacts}
              >
                Close
              </button>
            </div>
            <p className={styles.mergeSubtitle}>
              Choose the record to keep. All meetings, emails, and data from the others will be merged into it.
            </p>
            <div className={styles.mergeContactList}>
              {mergeDialogContacts.map((contact) => {
                const isKeep = contact.id === mergeKeepId
                return (
                  <label key={contact.id} className={`${styles.mergeContactRow} ${isKeep ? styles.mergeContactRowKeep : ''}`}>
                    <input
                      type="radio"
                      name="mergeKeep"
                      value={contact.id}
                      checked={isKeep}
                      onChange={() => setMergeKeepId(contact.id)}
                      disabled={mergingContacts}
                      className={styles.mergeContactRadio}
                    />
                    <div className={styles.mergeContactInfo}>
                      <div className={styles.mergeContactName}>
                        {contact.fullName}
                        {isKeep && <span className={styles.mergeRecommendedBadge}>Recommended</span>}
                      </div>
                      <div className={styles.mergeContactMeta}>
                        <span>{contact.email ?? '—'}</span>
                        <span className={styles.mergeMetaDot}>·</span>
                        <span>{contact.primaryCompanyName ?? '—'}</span>
                        <span className={styles.mergeMetaDot}>·</span>
                        <span>{contact.meetingCount} meeting{contact.meetingCount !== 1 ? 's' : ''}</span>
                        <span className={styles.mergeMetaDot}>·</span>
                        <span>{contact.emailCount} email{contact.emailCount !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
            {mergeError && (
              <p className={styles.mergeError}>{mergeError}</p>
            )}
            <div className={styles.mergeActions}>
              <button
                className={styles.dedupCancelButton}
                onClick={() => setMergeDialogContacts(null)}
                type="button"
                disabled={mergingContacts}
              >
                Cancel
              </button>
              <button
                className={styles.mergeConfirmButton}
                onClick={() => void handleMerge()}
                type="button"
                disabled={mergingContacts || !mergeKeepId}
              >
                {mergingContacts ? 'Merging...' : `Merge ${mergeDialogContacts.length} Contacts`}
              </button>
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
