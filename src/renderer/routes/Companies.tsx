import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import ChatInterface from '../components/chat/ChatInterface'
import { CompanyTable } from '../components/company/CompanyTable'
import { ViewsBar } from '../components/crm/ViewsBar'
import {
  COLUMN_DEFS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  buildUrlFilter,
  filterCompanies,
  loadColumnConfig,
  sortRows,
  type CompanyScope,
  type SortState
} from '../components/company/companyColumns'
import type {
  CompanyEntityType,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound,
  CompanySummary
} from '../../shared/types/company'
import styles from './Companies.module.css'
import { api } from '../api'

const SCOPE_LABELS: Record<CompanyScope, string> = {
  all: 'All Orgs',
  prospects: 'Prospects',
  vc_fund: 'Investors',
  unknown: 'Unknown'
}

// Backend-sortable column keys — all others are sorted client-side
const BACKEND_SORT_KEYS = new Set(['name', 'lastTouchpoint'])

interface CreateFormState {
  name: string
  description: string
  domain: string
  city: string
  state: string
  entityType: CompanyEntityType
  pipelineStage: CompanyPipelineStage | ''
  priority: CompanyPriority | ''
  round: CompanyRound | ''
  postMoney: string
  raiseSize: string
  contactName: string
  contactEmail: string
}

const EMPTY_FORM: CreateFormState = {
  name: '',
  description: '',
  domain: '',
  city: '',
  state: '',
  entityType: 'unknown',
  pipelineStage: '',
  priority: '',
  round: '',
  postMoney: '',
  raiseSize: '',
  contactName: '',
  contactEmail: ''
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
  const typeFilter = searchParams.getAll('type') as CompanyEntityType[]
  const stageFilter = searchParams.getAll('stage') as CompanyPipelineStage[]
  const priorityFilter = searchParams.getAll('priority') as CompanyPriority[]

  // ── Column visibility (lifted from CompanyTable so ViewsBar can control it) ─
  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => loadColumnConfig())

  // ── Data ────────────────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Filter picker ───────────────────────────────────────────────────────────
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!filterOpen) return
    function handle(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [filterOpen])

  // ── Create form ─────────────────────────────────────────────────────────────
  const [formState, setFormState] = useState<CreateFormState>(EMPTY_FORM)
  const createCardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showCreate) return
    createCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showCreate])

  const patchForm = (patch: Partial<CreateFormState>) =>
    setFormState((prev) => ({ ...prev, ...patch }))

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
    setFormState(EMPTY_FORM)
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

  const toggleFilter = useCallback(
    (param: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        const existing = next.getAll(param)
        next.delete(param)
        if (existing.includes(value)) {
          existing.filter((v) => v !== value).forEach((v) => next.append(param, v))
        } else {
          [...existing, value].forEach((v) => next.append(param, v))
        }
        return next
      })
    },
    [setSearchParams]
  )

  const clearFilter = useCallback(
    (param: string, value?: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (value === undefined) {
          next.delete(param)
        } else {
          const remaining = next.getAll(param).filter((v) => v !== value)
          next.delete(param)
          remaining.forEach((v) => next.append(param, v))
        }
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
    const tFilter = searchParams.getAll('type') as CompanyEntityType[]
    const sFilter = searchParams.getAll('stage') as CompanyPipelineStage[]
    const pFilter = searchParams.getAll('priority') as CompanyPriority[]
    const sortKey = searchParams.get('sortKey') || 'lastTouchpoint'
    const sortDir = (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc'
    const filtered = filterCompanies(companies, tFilter, sFilter, pFilter)
    if (BACKEND_SORT_KEYS.has(sortKey)) return filtered
    return sortRows(filtered, { key: sortKey, dir: sortDir }, COLUMN_DEFS)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, searchParams])

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

  // ── Create form submit ──────────────────────────────────────────────────────
  const handleCreateCompany = async () => {
    if (!formState.name.trim()) return
    try {
      const created = await api.invoke<CompanySummary>(IPC_CHANNELS.COMPANY_CREATE, {
        canonicalName: formState.name.trim(),
        description: formState.description.trim() || null,
        primaryDomain: formState.domain.trim() || null,
        entityType: formState.entityType,
        primaryContact:
          formState.contactName.trim() && formState.contactEmail.trim()
            ? { fullName: formState.contactName.trim(), email: formState.contactEmail.trim() }
            : undefined
      })
      const updates: Record<string, unknown> = {}
      if (formState.city.trim()) updates.city = formState.city.trim()
      if (formState.state.trim()) updates.state = formState.state.trim()
      if (formState.pipelineStage) updates.pipelineStage = formState.pipelineStage
      if (formState.priority) updates.priority = formState.priority
      if (formState.round) updates.round = formState.round
      if (formState.postMoney.trim()) updates.postMoneyValuation = Number(formState.postMoney)
      if (formState.raiseSize.trim()) updates.raiseSize = Number(formState.raiseSize)
      if (Object.keys(updates).length > 0) {
        await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, updates)
      }
      closeCreateForm()
      await fetchCompanies()
      navigate(`/company/${created.id}`)
    } catch (err) {
      setError(String(err))
    }
  }

  // ── Feature flag gate ───────────────────────────────────────────────────────
  if (!flagsLoading && !companiesEnabled) {
    return (
      <EmptyState
        title="Companies disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  const activeFilterCount = typeFilter.length + stageFilter.length + priorityFilter.length

  return (
    <div className={styles.container}>
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
        <button className={styles.newButton} onClick={openCreateForm}>+ New</button>
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

      {/* Filter chips row */}
      <div className={styles.filterRow}>
        {scope === 'all' &&
          typeFilter.map((v) => {
            const label = ENTITY_TYPES.find((o) => o.value === v)?.label ?? v
            return (
              <span key={v} className={styles.filterChip}>
                Type: {label}
                <button className={styles.filterChipX} onClick={() => clearFilter('type', v)}>
                  ×
                </button>
              </span>
            )
          })}
        {stageFilter.map((v) => {
          const label = STAGES.find((o) => o.value === v)?.label ?? v
          return (
            <span key={v} className={styles.filterChip}>
              Stage: {label}
              <button className={styles.filterChipX} onClick={() => clearFilter('stage', v)}>
                ×
              </button>
            </span>
          )
        })}
        {priorityFilter.map((v) => {
          const label = PRIORITIES.find((o) => o.value === v)?.label ?? v
          return (
            <span key={v} className={styles.filterChip}>
              Priority: {label}
              <button className={styles.filterChipX} onClick={() => clearFilter('priority', v)}>
                ×
              </button>
            </span>
          )
        })}

        {/* Filter picker dropdown */}
        <div ref={filterRef} className={styles.filterPickerWrap}>
          <button
            className={`${styles.filterPickerBtn} ${activeFilterCount > 0 ? styles.filterPickerBtnActive : ''}`}
            onClick={() => setFilterOpen((v) => !v)}
          >
            + Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          {filterOpen && (
            <div className={styles.filterDropdown}>
              {scope === 'all' && (
                <div className={styles.filterSection}>
                  <div className={styles.filterSectionLabel}>Type</div>
                  {ENTITY_TYPES.map((o) => (
                    <label key={o.value} className={styles.filterOption}>
                      <input
                        type="checkbox"
                        checked={typeFilter.includes(o.value)}
                        onChange={() => toggleFilter('type', o.value)}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              <div className={styles.filterSection}>
                <div className={styles.filterSectionLabel}>Stage</div>
                {STAGES.map((o) => (
                  <label key={o.value} className={styles.filterOption}>
                    <input
                      type="checkbox"
                      checked={stageFilter.includes(o.value)}
                      onChange={() => toggleFilter('stage', o.value)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              <div className={styles.filterSection}>
                <div className={styles.filterSectionLabel}>Priority</div>
                {PRIORITIES.map((o) => (
                  <label key={o.value} className={styles.filterOption}>
                    <input
                      type="checkbox"
                      checked={priorityFilter.includes(o.value)}
                      onChange={() => toggleFilter('priority', o.value)}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              {activeFilterCount > 0 && (
                <div className={styles.filterClearAll}>
                  <button
                    onClick={() => {
                      setSearchParams((prev) => {
                        const next = new URLSearchParams(prev)
                        next.delete('type')
                        next.delete('stage')
                        next.delete('priority')
                        return next
                      })
                      setFilterOpen(false)
                    }}
                  >
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Create form */}
      {showCreate && (
        <div ref={createCardRef} className={styles.createCard}>
          <div className={styles.createFormGrid}>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Company Name</label>
              <input
                className={styles.input}
                value={formState.name}
                onChange={(e) => patchForm({ name: e.target.value })}
                autoFocus
              />
            </div>
            <div>
              <label className={styles.createLabel}>Domain</label>
              <input
                className={styles.input}
                placeholder="e.g. acme.com"
                value={formState.domain}
                onChange={(e) => patchForm({ domain: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>City</label>
              <input
                className={styles.input}
                value={formState.city}
                onChange={(e) => patchForm({ city: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>State</label>
              <input
                className={styles.input}
                placeholder="e.g. CA"
                value={formState.state}
                onChange={(e) => patchForm({ state: e.target.value })}
              />
            </div>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Description</label>
              <textarea
                className={styles.textarea}
                value={formState.description}
                onChange={(e) => patchForm({ description: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>Entity Type</label>
              <select
                className={styles.createSelect}
                value={formState.entityType}
                onChange={(e) => patchForm({ entityType: e.target.value as CompanyEntityType })}
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Pipeline Stage</label>
              <select
                className={styles.createSelect}
                value={formState.pipelineStage}
                onChange={(e) => patchForm({ pipelineStage: e.target.value as CompanyPipelineStage | '' })}
              >
                <option value="">None</option>
                {STAGES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Priority</label>
              <select
                className={styles.createSelect}
                value={formState.priority}
                onChange={(e) => patchForm({ priority: e.target.value as CompanyPriority | '' })}
              >
                <option value="">None</option>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Round</label>
              <select
                className={styles.createSelect}
                value={formState.round}
                onChange={(e) => patchForm({ round: e.target.value as CompanyRound | '' })}
              >
                <option value="">None</option>
                {ROUNDS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Post Money ($M)</label>
              <input
                className={styles.input}
                type="number"
                step="0.1"
                value={formState.postMoney}
                onChange={(e) => patchForm({ postMoney: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>Raise Size ($M)</label>
              <input
                className={styles.input}
                type="number"
                step="0.1"
                value={formState.raiseSize}
                onChange={(e) => patchForm({ raiseSize: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>Primary Contact Name</label>
              <input
                className={styles.input}
                placeholder="e.g. Jane Smith"
                value={formState.contactName}
                onChange={(e) => patchForm({ contactName: e.target.value })}
              />
            </div>
            <div>
              <label className={styles.createLabel}>Primary Contact Email</label>
              <input
                className={styles.input}
                placeholder="e.g. jane@acme.com"
                value={formState.contactEmail}
                onChange={(e) => patchForm({ contactEmail: e.target.value })}
              />
            </div>
          </div>
          <div className={styles.createActions}>
            <button
              className={styles.createBtn}
              onClick={() => void handleCreateCompany()}
              disabled={!formState.name.trim()}
            >
              Create
            </button>
            <button className={styles.createCancelBtn} onClick={closeCreateForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
      />

      {/* Chat bar — pinned below table */}
      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
