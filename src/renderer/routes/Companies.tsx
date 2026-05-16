import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStaleGuard } from '../hooks/useStaleGuard'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { buildBackState } from '../utils/backNavState'
import NewCompanyModal from '../components/company/NewCompanyModal'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import { CompanyTable } from '../components/company/CompanyTable'
import { ViewsBar, type ViewsBarHandle } from '../components/crm/ViewsBar'
import { useLastView } from '../hooks/useLastView'
import { CreateCustomFieldModal } from '../components/crm/CreateCustomFieldModal'
import { FilterChips } from '../components/crm/FilterChips'
import {
  COLUMN_DEFS,
  COMPANY_GROUPABLE_FIELDS,
  DEFAULT_VISIBLE_KEYS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  buildUrlFilter,
  filterCompanies,
  loadColumnConfig,
  saveColumnConfig,
  type SortKey,
  type SortState
} from '../components/company/companyColumns'
import { sortRows, buildCustomFieldColumnDefs } from '../components/crm/tableUtils'
import { useGroupedRows } from '../hooks/useGroupedRows'
import { GroupByPicker } from '../components/crm/GroupByPicker'
import { SmartFilters, type FilterPreset } from '../components/crm/SmartFilters'
import { useTableFilters } from '../hooks/useTableFilters'
import { useCustomFieldValues } from '../hooks/useCustomFieldValues'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import type { CustomFieldDefinition } from '../../shared/types/custom-fields'
import type {
  CompanySummary,
  CompanyDedupAction,
  CompanyDedupApplyResult,
  CompanyDedupDecision,
  CompanyDuplicateGroup,
  CompanyMergePreview
} from '../../shared/types/company'
import styles from './Companies.module.css'
import { api } from '../api'
import { ipcCache } from '../api/ipcCache'
import { MergeReviewModal } from '../components/company/MergeReviewModal'
import { resolveDedupKeep } from '../utils/dedupKeep'

// ─── Smart filter presets ────────────────────────────────────────────────────

const get30DaysAgo = () => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10) }
const getStartOfWeek = () => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10) }
const getToday = () => new Date().toISOString().slice(0, 10)

const COMPANY_PRESETS: FilterPreset[] = [
  { id: 'no-touch-30',    label: 'No touch in 30d', getParams: () => ({ lastTouchpoint_max: get30DaysAgo() }), paramKeys: ['lastTouchpoint_max'] },
  { id: 'high-priority',  label: 'High priority',   getParams: () => ({ priority: 'high' }),                   paramKeys: ['priority'] },
  { id: 'needs-followup', label: 'Needs follow-up',  getParams: () => ({ nextFollowupDate_min: '2000-01-01', nextFollowupDate_max: getToday() }), paramKeys: ['nextFollowupDate_min', 'nextFollowupDate_max'] },
  { id: 'added-this-week',label: 'Added this week', getParams: () => ({ createdAt_min: getStartOfWeek() }),    paramKeys: ['createdAt_min'] },
]

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
  round: 'round',
  portfolioFund: 'fund',
  investmentRound: 'investmentRound',
  initialInvestmentSecurity: 'initialSecurity'
}

export default function Companies() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: companiesEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')
  // mountId was added to force a refetch after back-navigation. Unclear if it
  // does anything useful: it's stable within a mount (so doesn't affect
  // re-render fetches) and on remount the component starts fresh anyway (so
  // fetchCompanies is already a new function). Verify in DevTools with
  // `[ipc-perf] COMPANY_LIST` logs before removing.
  const [mountId] = useState(() => Date.now())

  // ── URL-derived state ───────────────────────────────────────────────────────
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'
  const groupBy = searchParams.get('groupBy') || null
  /** ?stubs=1 — investor-pollution review mode (Phase 3). */
  const stubsView = searchParams.get('stubs') === '1'

  // Multi-column sort — new format: ?sort=key:dir,key:dir
  // Legacy fallback: ?sortKey=...&sortDir=... for saved views
  const sort = useMemo<SortState>(() => {
    const raw = searchParams.get('sort')
    if (raw) {
      const parsed = raw.split(',')
        .filter((p) => p.includes(':'))
        .map((p) => {
          const [key, d] = p.split(':')
          return { key, dir: d === 'asc' ? 'asc' : 'desc' } as SortKey
        })
      if (parsed.length > 0) return parsed
    }
    return [{
      key: searchParams.get('sortKey') || 'lastTouchpoint',
      dir: (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc'
    }]
  }, [searchParams])

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // ── Column visibility (lifted from CompanyTable so ViewsBar can control it) ─
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => loadColumnConfig())

  // ── Persist & restore last-active view for sidebar navigation ──────────────
  useLastView('cyggie:companies-last-view', '/companies', searchParams, visibleKeys, navigate, setVisibleKeys, saveColumnConfig)

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
  const viewsBarRef = useRef<ViewsBarHandle>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [applyingDedup, setApplyingDedup] = useState(false)
  const [dedupGroups, setDedupGroups] = useState<CompanyDuplicateGroup[] | null>(null)
  const [dedupActionsByGroup, setDedupActionsByGroup] = useState<Record<string, CompanyDedupAction>>({})
  const [dedupKeepByGroup, setDedupKeepByGroup] = useState<Record<string, string>>({})
  const [dedupSelectedByGroup, setDedupSelectedByGroup] = useState<Record<string, string[]>>({})
  // Per-group conflict count: total scalar-field conflicts across all
  // keeper-vs-source pairs in a group with action='merge'. Updated by an
  // effect below. -1 = not yet computed (or stale); 0 = safe to bulk-apply;
  // >0 = group needs per-pair Review before merging.
  const [dedupConflictsByGroup, setDedupConflictsByGroup] = useState<Record<string, number>>({})
  // The keeper/source pair currently being reviewed, if any.
  const [reviewMergePair, setReviewMergePair] = useState<{ groupKey: string; targetId: string; sourceId: string } | null>(null)
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
  const closeCreateForm = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('new')
      return next
    })
  }, [setSearchParams])

  const handleSort = useCallback(
    (key: string, shiftHeld: boolean) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        const existing = sort.findIndex((s) => s.key === key)

        let newSort: SortKey[]
        if (shiftHeld) {
          if (existing >= 0) {
            // Shift+click existing: remove this key from the sort
            newSort = sort.filter((s) => s.key !== key)
          } else {
            // Shift+click new: append
            newSort = [...sort, { key, dir: 'asc' }]
          }
        } else {
          if (existing >= 0) {
            // No shift, key already in array: toggle direction, drop others
            const prevDir = sort[existing].dir
            newSort = [{ key, dir: prevDir === 'asc' ? 'desc' : 'asc' }]
          } else {
            // No shift, new key: replace
            newSort = [{ key, dir: 'asc' }]
          }
        }
        if (newSort.length === 0) newSort = [{ key: 'lastTouchpoint', dir: 'desc' }]

        // Write new format, remove legacy params
        next.set('sort', newSort.map((s) => `${s.key}:${s.dir}`).join(','))
        next.delete('sortKey')
        next.delete('sortDir')
        return next
      })
    },
    [setSearchParams, sort]
  )

  const handleSetGroupBy = useCallback(
    (key: string | null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (key) next.set('groupBy', key)
        else next.delete('groupBy')
        return next
      })
      // Reset collapsed groups when changing group-by
      setCollapsedGroups(new Set())
    },
    [setSearchParams]
  )

  const handleToggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  // ── Fetch ───────────────────────────────────────────────────────────────────
  // Map sort key to the two backend-supported sort modes
  const backendSortBy = sort[0]?.key === 'name' ? ('name' as const) : ('recent_touch' as const)

  const getGuard = useStaleGuard()

  const needsInvestorNames = visibleKeys.includes('coInvestorNames')
    || visibleKeys.includes('priorInvestorNames')
    || visibleKeys.includes('subsequentInvestorNames')

  const fetchCompanies = useCallback(async () => {
    if (!companiesEnabled) return
    const isStale = getGuard()
    setLoading(true)
    setError(null)
    try {
      const filter = buildUrlFilter(query, backendSortBy, {
        includeInvestorNames: needsInvestorNames,
      })
      if (stubsView) filter.view = 'stubs'
      const results = await ipcCache.get<CompanySummary[]>(
        IPC_CHANNELS.COMPANY_LIST,
        filter,
        () => api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, filter),
      )
      if (isStale()) return
      setCompanies(results)
    } catch (err) {
      if (isStale()) return
      setError(String(err))
    } finally {
      if (!isStale()) setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companiesEnabled, query, backendSortBy, needsInvestorNames, stubsView, getGuard, mountId])

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

  // ── Ensure default saved views exist ─────────────────────────────────────────
  useEffect(() => {
    const STORAGE_KEY = 'cyggie:company-views'
    let existing: Array<{ id: string; name: string; urlParams: string; columns: string[] }> = []
    try { existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { /* corrupt — reset */ }
    const fundIvColumns = [
      'name', 'description', 'primaryDomain', 'industry', 'location', 'status',
      'totalInvested', 'investmentMark', 'investmentRound', 'investmentSize',
      'initialInvestmentSecurity', 'dateOfInitialInvestment', 'ownershipPct',
      'initialRoundSize', 'postMoneyValuation', 'lastCompanyValuation', 'round',
      'followonCheck', 'followonDate', 'followonCheck2', 'followonDate2',
      'coInvestorNames', 'subsequentInvestorNames'
    ]
    const fundIv = existing.find(v => v.id === 'fund-iv-default')
    let mutated = false
    if (!fundIv) {
      existing.push({
        id: 'fund-iv-default',
        name: 'Fund IV',
        urlParams: 'type=portfolio&fund=fund_iv',
        columns: fundIvColumns
      })
      mutated = true
    } else {
      // Migrate legacy column keys (industriesCsv/sector → industry) on existing saved views.
      const legacyIdx = fundIv.columns.findIndex(c => c === 'industriesCsv' || c === 'sector')
      if (legacyIdx >= 0) {
        if (fundIv.columns.includes('industry')) {
          fundIv.columns.splice(legacyIdx, 1)
        } else {
          fundIv.columns[legacyIdx] = 'industry'
        }
        mutated = true
      }
      if (!fundIv.columns.includes('status')) {
        // Patch existing saved view: insert 'status' after 'location' (or at end).
        const locIdx = fundIv.columns.indexOf('location')
        const insertAt = locIdx >= 0 ? locIdx + 1 : fundIv.columns.length
        fundIv.columns.splice(insertAt, 0, 'status')
        mutated = true
      }
    }
    if (mutated) localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
  }, [])

  // ── Custom field types for filter dispatch ────────────────────────────────
  // applyCustomRangeFilter needs to know if a custom value should be compared
  // numerically or as a date string. Build a stable Record<defId, fieldType>
  // map from companyDefs once per defs change.
  const customFieldTypes = useMemo(
    () => Object.fromEntries(companyDefs.map((d) => [d.id, d.fieldType])),
    [companyDefs]
  )

  // ── Derived display list ─────────────────────────────────────────────────────
  const displayCompanies = useMemo(() => {
    const filtered = filterCompanies(companies, {
      columnFilters,
      rangeFilters,
      textFilters,
      customFieldValues,
      customFieldTypes,
    })
    // Short-circuit: if primary sort is backend-sorted and no secondary sorts, skip client sort
    if (BACKEND_SORT_KEYS.has(sort[0]?.key ?? '') && sort.length === 1) return filtered
    return sortRows(filtered, sort, COLUMN_DEFS)
  }, [companies, columnFilters, rangeFilters, textFilters, customFieldValues, customFieldTypes, sort])

  const groupedRows = useGroupedRows(displayCompanies, groupBy, COMPANY_GROUPABLE_FIELDS, collapsedGroups)

  const dedupActionableGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action === 'skip') return false
        const validIds = new Set(group.companies.map((c) => c.id))
        const ready = ((dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))).length >= 2
        if (!ready) return false
        // Merge groups with field conflicts must be reviewed individually —
        // they don't count toward the bulk-apply tally.
        if (action === 'merge' && (dedupConflictsByGroup[group.key] || 0) > 0) return false
        return true
      }).length
    : 0

  const dedupNeedReviewGroups = dedupGroups
    ? dedupGroups.filter((group) => {
        const action = dedupActionsByGroup[group.key] || 'skip'
        return action === 'merge' && (dedupConflictsByGroup[group.key] || 0) > 0
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
      navigate(`/company/${created.id}`, { state: buildBackState(location, 'Companies') })
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
      // Bulk apply only handles groups with no field conflicts. Groups with
      // conflicts must go through MergeReviewModal via per-row Review.
      const decisions: CompanyDedupDecision[] = dedupGroups.map((group) => {
        const validCompanyIds = new Set(group.companies.map((c) => c.id))
        const selectedCompanyIds = (dedupSelectedByGroup[group.key] || [])
          .filter((id) => validCompanyIds.has(id))
        const rawAction = dedupActionsByGroup[group.key] || 'skip'
        // Demote merge groups that have conflicts to 'skip' for the bulk apply.
        const action = (rawAction === 'merge' && (dedupConflictsByGroup[group.key] || 0) > 0)
          ? 'skip' as const
          : rawAction
        const keepCompanyId = resolveDedupKeep(group, selectedCompanyIds, dedupKeepByGroup[group.key])
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
  }, [dedupActionsByGroup, dedupGroups, dedupKeepByGroup, dedupSelectedByGroup, dedupConflictsByGroup, fetchCompanies])

  // ── Conflict preview computation ──────────────────────────────────────────
  // For every group with action='merge', sum the scalar-field conflicts across
  // every keeper-vs-source pair. Groups with conflicts > 0 are gated behind a
  // per-row Review button instead of bulk apply.
  useEffect(() => {
    if (!dedupGroups) {
      setDedupConflictsByGroup({})
      return
    }
    let cancelled = false
    const compute = async () => {
      const next: Record<string, number> = {}
      for (const group of dedupGroups) {
        const action = dedupActionsByGroup[group.key] || 'skip'
        if (action !== 'merge') continue
        const validIds = new Set(group.companies.map((c) => c.id))
        const selected = (dedupSelectedByGroup[group.key] || []).filter((id) => validIds.has(id))
        if (selected.length < 2) continue
        const keep = resolveDedupKeep(group, selected, dedupKeepByGroup[group.key])
        const sources = selected.filter((id) => id !== keep)
        let total = 0
        for (const sourceId of sources) {
          try {
            const preview = await api.invoke<CompanyMergePreview>(
              IPC_CHANNELS.COMPANY_MERGE_PREVIEW, keep, sourceId
            )
            total += preview.conflicts.length
          } catch {
            // Treat missing previews as needs-review so we don't bulk-apply
            // a merge whose state we couldn't read.
            total += 1
          }
        }
        next[group.key] = total
      }
      if (!cancelled) setDedupConflictsByGroup(next)
    }
    void compute()
    return () => { cancelled = true }
  }, [dedupGroups, dedupActionsByGroup, dedupKeepByGroup, dedupSelectedByGroup])

  // ── Create modal callbacks ─────────────────────────────────────────────────
  const handleCompanyCreated = useCallback(async (company: CompanySummary) => {
    closeCreateForm()
    await fetchCompanies()
    navigate(`/company/${company.id}`, { state: buildBackState(location, 'Companies') })
  }, [closeCreateForm, fetchCompanies, navigate, location])

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
        <div className={styles.statusBanner}>
          <div>
            De-dup reviewed: {dedupResult.reviewedGroups} groups, merged: {dedupResult.mergedGroups}{' '}
            ({dedupResult.mergedCompanies} companies), deleted: {dedupResult.deletedGroups}{' '}
            ({dedupResult.deletedCompanies} companies), skipped: {dedupResult.skippedGroups}
            {dedupResult.failures.length > 0 ? `, failures: ${dedupResult.failures.length}` : ''}
          </div>
          {dedupResult.failures.length > 0 && (
            <ul className={styles.dedupFailureList}>
              {dedupResult.failures.map((f, i) => (
                <li key={`${f.groupKey}-${i}`}>
                  <strong>{f.groupKey}</strong> ({f.action}): {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Saved views bar + 3-dot menu */}
      <div className={styles.header}>
        <ViewsBar
          ref={viewsBarRef}
          storageKey="cyggie:company-views"
          currentParams={searchParams}
          currentColumns={visibleKeys}
          defaultColumns={DEFAULT_VISIBLE_KEYS}
          entityLabel="Companies"
          onApply={(params, columns) => {
            setSearchParams(params)
            setVisibleKeys(columns)
          }}
          hideSaveButton
        />
        <div className={styles.actionsDropdown} ref={actionsRef}>
          <button
            className={styles.moreBtn}
            onClick={() => setActionsOpen((v) => !v)}
            disabled={busy}
            title="More actions"
          >
            ⋮
          </button>
          {actionsOpen && (
            <div className={styles.actionsMenu}>
              <button
                className={styles.actionsMenuItem}
                onClick={() => { viewsBarRef.current?.openSave(); setActionsOpen(false) }}
              >
                Save View
              </button>
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
      </div>

      {/* Toolbar row 2: group-by picker + clear sort + smart filters */}
      <div className={styles.toolbarRow2}>
        <GroupByPicker
          value={groupBy}
          fields={COMPANY_GROUPABLE_FIELDS}
          onChange={handleSetGroupBy}
        />
        {sort.length > 1 && (
          <button
            className={styles.clearSortBtn}
            onClick={() => setSearchParams((prev) => {
              const next = new URLSearchParams(prev)
              next.delete('sort')
              next.delete('sortKey')
              next.delete('sortDir')
              return next
            })}
          >
            Clear sort ✕
          </button>
        )}
        <SmartFilters
          presets={COMPANY_PRESETS}
          searchParams={searchParams}
          onApply={(params) => setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            Object.entries(params).forEach(([k, v]) => next.set(k, v))
            return next
          })}
          onClear={(keys) => setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            keys.forEach((k) => next.delete(k))
            return next
          })}
        />
      </div>

      <FilterChips
        columnFilters={columnFilters}
        rangeFilters={rangeFilters}
        textFilters={textFilters}
        columnDefs={COLUMN_DEFS}
        onColumnFilter={handleColumnFilter}
        onRangeFilter={handleRangeFilter}
        onTextFilter={handleTextFilter}
        clearAllFilters={clearAllFilters}
      />

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
                    const selectedKeep = resolveDedupKeep(group, selectedCompanyIds, dedupKeepByGroup[group.key])
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
                                <span className={styles.dedupContactRichness}>
                                  {company.populatedFieldCount} fields
                                  {' · '}{company.meetingCount} meetings
                                  {' · '}{company.emailCount} emails
                                  {' · '}{company.noteCount} notes
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
                          {selectedAction === 'merge' && (dedupConflictsByGroup[group.key] || 0) > 0 && (() => {
                            const firstSource = selectedCompanyIds.find((id) => id !== selectedKeep)
                            if (!firstSource) return null
                            return (
                              <button
                                type="button"
                                className={styles.dedupReviewButton}
                                onClick={() => setReviewMergePair({ groupKey: group.key, targetId: selectedKeep, sourceId: firstSource })}
                                disabled={applyingDedup}
                              >
                                Review ({dedupConflictsByGroup[group.key]} conflict{dedupConflictsByGroup[group.key] === 1 ? '' : 's'})
                              </button>
                            )
                          })()}
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
                {dedupNeedReviewGroups > 0 ? ` · ${dedupNeedReviewGroups} need${dedupNeedReviewGroups === 1 ? 's' : ''} review` : ''}
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
                  title={dedupNeedReviewGroups > 0 ? 'Conflict-free groups will be applied; review-required groups will remain.' : undefined}
                >
                  {applyingDedup
                    ? 'Applying...'
                    : `Apply ${dedupActionableGroups} Action${dedupActionableGroups === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {reviewMergePair && (
        <MergeReviewModal
          open={true}
          targetId={reviewMergePair.targetId}
          sourceId={reviewMergePair.sourceId}
          onCancel={() => setReviewMergePair(null)}
          onSuccess={async () => {
            setReviewMergePair(null)
            // Refresh both the company list and the dedup groups so the
            // merged-away source disappears and conflict counts update.
            await fetchCompanies()
            await reviewDuplicates(true)
          }}
        />
      )}

    </div>
  )
}
