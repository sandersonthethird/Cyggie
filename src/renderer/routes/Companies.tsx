import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import NewCompanyModal from '../components/company/NewCompanyModal'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import ChatInterface from '../components/chat/ChatInterface'
import { CompanyTable } from '../components/company/CompanyTable'
import { ViewsBar } from '../components/crm/ViewsBar'
import { CreateCustomFieldModal } from '../components/crm/CreateCustomFieldModal'
import {
  COLUMN_DEFS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  buildUrlFilter,
  filterCompanies,
  loadColumnConfig,
  saveColumnConfig,
  type CompanyScope,
  type SortState
} from '../components/company/companyColumns'
import { sortRows, buildCustomFieldColumnDefs } from '../components/crm/tableUtils'
import { useTableFilters } from '../hooks/useTableFilters'
import { useCustomFieldValues } from '../hooks/useCustomFieldValues'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import type { CustomFieldDefinition } from '../../shared/types/custom-fields'
import type {
  CompanySummary,
  CompanyDedupAction,
  CompanyDedupApplyResult,
  CompanyDedupDecision,
  CompanyDuplicateGroup
} from '../../shared/types/company'
import styles from './Companies.module.css'
import { api } from '../api'

const SCOPE_LABELS: Record<CompanyScope, string> = {
  all: 'All Orgs',
  prospects: 'Prospects',
  vc_fund: 'Investors',
  unknown: 'Unknown',
  hidden: 'Hidden',
}

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

function dedupActionLabel(action: CompanyDedupAction): string {
  if (action === 'delete') return 'Delete extras'
  if (action === 'merge') return 'Merge into keep'
  return 'Skip'
}

function normalizeSortKey(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

// Backend-sortable column keys — all others are sorted client-side
const BACKEND_SORT_KEYS = new Set(['name', 'lastTouchpoint'])


// Maps ColumnDef.field → URL param name for backwards-compat with existing saved views.
// Must be a stable module-level const (passed to useTableFilters as fieldToParamMap).
const FIELD_TO_PARAM: Record<string, string> = {
  entityType: 'type',
  pipelineStage: 'stage',
  priority: 'priority',
  round: 'round'
}

export default function Companies() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: companiesEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')

  // ── URL-derived state ───────────────────────────────────────────────────────
  const query = (searchParams.get('q') || '').trim()
  const scope = (searchParams.get('scope') || 'all') as CompanyScope
  const showCreate = searchParams.get('new') === '1'
  const sort: SortState = {
    key: searchParams.get('sortKey') || 'lastTouchpoint',
    dir: (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc'
  }

  // ── Column visibility (lifted from CompanyTable so ViewsBar can control it) ─
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => loadColumnConfig())

  // ── Data ────────────────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<CompanySummary[]>([])

  // ── Custom fields ───────────────────────────────────────────────────────────
  const { companyDefs, refresh: refreshCustomFields } = useCustomFieldStore()
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('cyggie:column-label-overrides:company') ?? '{}') }
    catch { return {} }
  })
  const allDefs = useMemo(() => {
    const customDefs = buildCustomFieldColumnDefs(companyDefs)
    return [...COLUMN_DEFS, ...customDefs].map((d) => ({
      ...d,
      label: labelOverrides[d.key] ?? d.label
    }))
  }, [companyDefs, labelOverrides])

  const { values: customFieldValues, patch: patchCustomField } = useCustomFieldValues(
    'company', visibleKeys, companies.length
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
      localStorage.setItem('cyggie:column-label-overrides:company', JSON.stringify(next))
    }
  }

  async function handleFieldCreated(def: CustomFieldDefinition) {
    await refreshCustomFields()
    const newKey = `custom:${def.id}`
    const next = [...visibleKeys, newKey]
    setVisibleKeys(next)
    saveColumnConfig(next)
    setCreateFieldOpen(false)
  }

  function handleHideColumn(key: string) {
    const next = visibleKeys.filter((k) => k !== key)
    setVisibleKeys(next)
    saveColumnConfig(next)
  }

  async function handleDeleteColumn(key: string) {
    if (!key.startsWith('custom:')) return
    const defId = key.slice(7)
    const r = await api.invoke<{ success: boolean; message?: string }>(
      IPC_CHANNELS.CUSTOM_FIELD_DELETE_DEFINITION, defId
    )
    if (!r.success) {
      console.warn('[deleteColumn] CUSTOM_FIELD_DELETE_DEFINITION failed', r.message)
      return
    }
    const next = visibleKeys.filter((k) => k !== key)
    setVisibleKeys(next)
    saveColumnConfig(next)
    await refreshCustomFields()
  }

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Actions / dedup ───────────────────────────────────────────────────────
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [applyingDedup, setApplyingDedup] = useState(false)
  const [dedupGroups, setDedupGroups] = useState<CompanyDuplicateGroup[] | null>(null)
  const [dedupActionsByGroup, setDedupActionsByGroup] = useState<Record<string, CompanyDedupAction>>({})
  const [dedupKeepByGroup, setDedupKeepByGroup] = useState<Record<string, string>>({})
  const [dedupSelectedByGroup, setDedupSelectedByGroup] = useState<Record<string, string[]>>({})
  const [dedupResult, setDedupResult] = useState<CompanyDedupApplyResult | null>(null)

  // ── Column / range / text filters — URL-driven via shared hook ──────────────
  const {
    columnFilters, rangeFilters, textFilters, activeFilterCount,
    handleColumnFilter, handleRangeFilter, handleTextFilter, clearAllFilters,
    paramForField
  } = useTableFilters({ columnDefs: COLUMN_DEFS, searchParams, setSearchParams, fieldToParamMap: FIELD_TO_PARAM })

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


  // ── URL helpers ─────────────────────────────────────────────────────────────
  const setScope = useCallback(
    (s: CompanyScope) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('scope', s)
        next.delete('type') // scope already constrains entityType
        return next
      })
    },
    [setSearchParams]
  )

  const openCreateForm = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('new', '1')
      return next
    })
  }, [setSearchParams])

  const closeCreateForm = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('new')
      return next
    })
  }, [setSearchParams])

  const handleSort = useCallback(
    (key: string, dir: 'asc' | 'desc') => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('sortKey', key)
        next.set('sortDir', dir)
        return next
      })
    },
    [setSearchParams]
  )

  // ── Fetch ───────────────────────────────────────────────────────────────────
  // Map sort key to the two backend-supported sort modes
  const backendSortBy = sort.key === 'name' ? ('name' as const) : ('recent_touch' as const)

  const fetchCompanies = useCallback(async () => {
    if (!companiesEnabled) return
    setLoading(true)
    setError(null)
    try {
      const filter = buildUrlFilter(scope, query, backendSortBy)
      const results = await api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, filter)
      setCompanies(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [companiesEnabled, scope, query, backendSortBy])

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    clearTimeout(searchDebounceRef.current)
    if (!query) {
      void fetchCompanies()
      return
    }
    searchDebounceRef.current = setTimeout(() => { void fetchCompanies() }, 300)
    return () => { clearTimeout(searchDebounceRef.current) }
  }, [fetchCompanies])

  // ── Derived display list ─────────────────────────────────────────────────────
  // searchParams captures all filter/sort URL state — no need to list individually
  const displayCompanies = useMemo(() => {
    const sortKey = searchParams.get('sortKey') || 'lastTouchpoint'
    const sortDir = (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc'
    const filtered = filterCompanies(companies, columnFilters, rangeFilters, textFilters)
    if (BACKEND_SORT_KEYS.has(sortKey)) return filtered
    return sortRows(filtered, { key: sortKey, dir: sortDir }, COLUMN_DEFS)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, columnFilters, rangeFilters, textFilters, searchParams])

  const dedupActionableGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action === 'skip') return false
        const validIds = new Set(group.companies.map((c) => c.id))
        return ((dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))).length >= 2
      }).length
    : 0

  const dedupIncompleteGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action === 'skip') return false
        const validIds = new Set(group.companies.map((c) => c.id))
        return ((dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))).length < 2
      }).length
    : 0

  const busy = checkingDuplicates || applyingDedup

  // ── CompanyTable callbacks ──────────────────────────────────────────────────
  const handlePatch = useCallback((id: string, patch: Record<string, unknown>) => {
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? ({ ...c, ...patch } as CompanySummary) : c))
    )
  }, [])

  const handleBulkDelete = useCallback(async () => {
    await fetchCompanies()
  }, [fetchCompanies])

  const handleCreateInline = useCallback(
    async (name: string) => {
      const created = await api.invoke<CompanySummary>(IPC_CHANNELS.COMPANY_CREATE, {
        canonicalName: name,
        entityType: 'unknown'
      })
      await fetchCompanies()
      navigate(`/company/${created.id}`)
    },
    [fetchCompanies, navigate]
  )

  // ── Dedup callbacks ───────────────────────────────────────────────────────
  const reviewDuplicates = useCallback(async (triggeredByRun = false) => {
    if (!companiesEnabled) return
    setCheckingDuplicates(true)
    setError(null)
    try {
      const groups = await api.invoke<CompanyDuplicateGroup[]>(
        IPC_CHANNELS.COMPANY_DEDUP_SUSPECTED,
        40
      )
      if (!groups || groups.length === 0) {
        setDedupGroups(null)
        setDedupSelectedByGroup({})
        if (!triggeredByRun) {
          setDedupResult({
            reviewedGroups: 0,
            mergedGroups: 0,
            deletedGroups: 0,
            skippedGroups: 0,
            mergedCompanies: 0,
            deletedCompanies: 0,
            failures: []
          })
        }
        return
      }

      const sortedGroups = [...groups].sort((a, b) => {
        const aKey = normalizeSortKey(a.domain || a.reason || a.key)
        const bKey = normalizeSortKey(b.domain || b.reason || b.key)
        if (aKey !== bKey) return aKey.localeCompare(bKey)
        return a.key.localeCompare(b.key)
      })

      setDedupGroups(sortedGroups)
      setDedupActionsByGroup((prev) => {
        const next: Record<string, CompanyDedupAction> = {}
        for (const group of sortedGroups) next[group.key] = prev[group.key] || 'skip'
        return next
      })
      setDedupKeepByGroup((prev) => {
        const next: Record<string, string> = {}
        for (const group of sortedGroups) {
          const preferred = prev[group.key] || group.suggestedKeepCompanyId
          const valid = group.companies.some((c) => c.id === preferred)
          next[group.key] = valid ? preferred : group.suggestedKeepCompanyId
        }
        return next
      })
      setDedupSelectedByGroup((prev) => {
        const next: Record<string, string[]> = {}
        for (const group of sortedGroups) {
          const validIds = new Set(group.companies.map((c) => c.id))
          next[group.key] = (prev[group.key] || []).filter((id) => validIds.has(id))
        }
        return next
      })
    } catch (err) {
      setError(String(err))
    } finally {
      setCheckingDuplicates(false)
    }
  }, [companiesEnabled])

  const closeDedupDialog = useCallback(() => {
    if (applyingDedup) return
    setDedupGroups(null)
    setDedupSelectedByGroup({})
  }, [applyingDedup])

  const applyDedupActions = useCallback(async () => {
    if (!dedupGroups || dedupGroups.length === 0) return
    setApplyingDedup(true)
    setError(null)
    try {
      const decisions: CompanyDedupDecision[] = dedupGroups.map((group) => {
        const validCompanyIds = new Set(group.companies.map((c) => c.id))
        const selectedCompanyIds = (dedupSelectedByGroup[group.key] || [])
          .filter((id) => validCompanyIds.has(id))
        const action = dedupActionsByGroup[group.key] || 'skip'
        const keepPreference = dedupKeepByGroup[group.key] || group.suggestedKeepCompanyId
        const keepCompanyId = selectedCompanyIds.includes(keepPreference)
          ? keepPreference
          : (selectedCompanyIds[0] || group.suggestedKeepCompanyId)
        const companyIds = selectedCompanyIds.includes(keepCompanyId)
          ? selectedCompanyIds
          : [keepCompanyId, ...selectedCompanyIds]
        if (action !== 'skip' && companyIds.length < 2) {
          throw new Error(`Select at least two companies for "${group.reason}" or set action to Skip`)
        }
        return { groupKey: group.key, action, keepCompanyId, companyIds }
      })

      const result = await api.invoke<CompanyDedupApplyResult>(
        IPC_CHANNELS.COMPANY_DEDUP_APPLY,
        decisions
      )
      setDedupResult(result)
      setDedupGroups(null)
      setDedupSelectedByGroup({})
      await fetchCompanies()
    } catch (err) {
      setError(String(err))
    } finally {
      setApplyingDedup(false)
    }
  }, [dedupActionsByGroup, dedupGroups, dedupKeepByGroup, dedupSelectedByGroup, fetchCompanies])

  // ── Create modal callbacks ─────────────────────────────────────────────────
  const handleCompanyCreated = useCallback(async (company: CompanySummary) => {
    closeCreateForm()
    await fetchCompanies()
    navigate(`/company/${company.id}`)
  }, [closeCreateForm, fetchCompanies, navigate])

  // ── Feature flag gate ───────────────────────────────────────────────────────
  if (!flagsLoading && !companiesEnabled) {
    return (
      <EmptyState
        title="Companies disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  return (
    <div className={styles.container}>
      {dedupResult && (
        <span className={styles.statusBanner}>
          De-dup reviewed: {dedupResult.reviewedGroups} groups, merged: {dedupResult.mergedGroups}{' '}
          ({dedupResult.mergedCompanies} companies), deleted: {dedupResult.deletedGroups}{' '}
          ({dedupResult.deletedCompanies} companies), skipped: {dedupResult.skippedGroups}
          {dedupResult.failures.length > 0 ? `, failures: ${dedupResult.failures.length}` : ''}
        </span>
      )}
      {/* Header: scope tabs + new button */}
      <div className={styles.header}>
        <div className={styles.scopeRow}>
          {(Object.keys(SCOPE_LABELS) as CompanyScope[]).map((s) => (
            <button
              key={s}
              className={`${styles.scopeButton} ${scope === s ? styles.activeScope : ''}`}
              onClick={() => setScope(s)}
            >
              {SCOPE_LABELS[s]}
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
                  onClick={() => { void reviewDuplicates(false); setActionsOpen(false) }}
                  disabled={busy}
                >
                  {checkingDuplicates ? 'Checking...' : 'Review Duplicates'}
                </button>
              </div>
            )}
          </div>
          <button className={styles.newButton} onClick={openCreateForm}>+ New</button>
        </div>
      </div>

      {/* Saved views bar */}
      <ViewsBar
        storageKey="cyggie:company-views"
        currentParams={searchParams}
        currentColumns={visibleKeys}
        onApply={(params, columns) => {
          setSearchParams(params)
          setVisibleKeys(columns)
        }}
      />

      {/* Filter chips row — dynamically generated from all active filters */}
      {activeFilterCount > 0 && (
        <div className={styles.filterRow}>
          {/* Select filter chips */}
          {Object.entries(columnFilters).flatMap(([field, values]) => {
            const col = COLUMN_DEFS.find((c) => c.field === field)
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
            const col = COLUMN_DEFS.find((c) => c.field === field)
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
            const col = COLUMN_DEFS.find((c) => c.field === field)
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

      {error && <div className={styles.error}>{error}</div>}

      {/* Create modal */}
      <NewCompanyModal
        open={showCreate}
        onCreated={(company) => void handleCompanyCreated(company)}
        onClose={closeCreateForm}
      />

      {/* Table — flex: 1 fills remaining height */}
      <CompanyTable
        companies={displayCompanies}
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
      />

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="company"
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
                disabled={applyingDedup}
              >
                Close
              </button>
            </div>
            <p className={styles.dedupSubtitle}>
              Check the companies to include for each action, then choose which checked company to keep.
            </p>
            <div className={styles.dedupTableWrap}>
              <table className={styles.dedupTable}>
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Companies</th>
                    <th>Action</th>
                    <th>Keep</th>
                  </tr>
                </thead>
                <tbody>
                  {dedupGroups.map((group) => {
                    const selectedAction = dedupActionsByGroup[group.key] || 'skip'
                    const validCompanyIds = new Set(group.companies.map((c) => c.id))
                    const selectedCompanyIds = (dedupSelectedByGroup[group.key] || [])
                      .filter((id) => validCompanyIds.has(id))
                    const keepPreference = dedupKeepByGroup[group.key] || group.suggestedKeepCompanyId
                    const selectedKeep = selectedCompanyIds.includes(keepPreference)
                      ? keepPreference
                      : (selectedCompanyIds[0] || group.suggestedKeepCompanyId)
                    const keepOptions = group.companies.filter((c) =>
                      selectedCompanyIds.includes(c.id)
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
                            {group.companies.length} companies · {selectedCompanyIds.length} selected
                          </div>
                        </td>
                        <td>
                          <div className={styles.dedupContactList}>
                            {group.companies.map((company) => (
                              <div key={company.id} className={styles.dedupContactItem}>
                                <div className={styles.dedupContactRow}>
                                  <label className={styles.dedupContactSelect}>
                                    <input
                                      type="checkbox"
                                      className={styles.dedupContactCheckbox}
                                      checked={selectedCompanyIds.includes(company.id)}
                                      onChange={(e) => {
                                        const checked = e.target.checked
                                        setDedupSelectedByGroup((prev) => {
                                          const groupIds = group.companies.map((c) => c.id)
                                          const current = (prev[group.key] || []).filter((id) => groupIds.includes(id))
                                          if (checked) {
                                            return current.includes(company.id)
                                              ? { ...prev, [group.key]: current }
                                              : { ...prev, [group.key]: [...current, company.id] }
                                          }
                                          return { ...prev, [group.key]: current.filter((id) => id !== company.id) }
                                        })
                                      }}
                                      disabled={applyingDedup}
                                    />
                                    <span className={styles.dedupContactName}>{company.canonicalName}</span>
                                  </label>
                                </div>
                                <span className={styles.dedupContactMeta}>
                                  {[
                                    company.primaryDomain,
                                    company.pipelineStage,
                                    company.entityType,
                                    formatDateTime(company.updatedAt)
                                  ].filter(Boolean).join(' · ')}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>
                          <select
                            className={styles.dedupSelect}
                            value={selectedAction}
                            onChange={(e) => {
                              const action = e.target.value as CompanyDedupAction
                              setDedupActionsByGroup((prev) => ({ ...prev, [group.key]: action }))
                            }}
                            disabled={applyingDedup}
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
                            disabled={applyingDedup || selectedAction === 'skip' || keepOptions.length === 0}
                          >
                            {keepOptions.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.canonicalName}{c.primaryDomain ? ` (${c.primaryDomain})` : ''}
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
                  disabled={applyingDedup}
                >
                  Cancel
                </button>
                <button
                  className={styles.dedupApplyButton}
                  onClick={() => void applyDedupActions()}
                  type="button"
                  disabled={applyingDedup || dedupActionableGroups === 0 || dedupIncompleteGroups > 0}
                >
                  {applyingDedup ? 'Applying...' : 'Apply Actions'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Chat bar — pinned below table */}
      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
