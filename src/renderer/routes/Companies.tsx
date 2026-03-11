import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useFeatureFlag } from '../hooks/useFeatureFlags'
import EmptyState from '../components/common/EmptyState'
import ChatInterface from '../components/chat/ChatInterface'
import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound,
  CompanySortBy,
  CompanySummary
} from '../../shared/types/company'
import styles from './Companies.module.css'

type CompanyScope = 'prospects' | 'all' | 'vc_fund' | 'unknown'

const SCOPE_LABELS: Record<CompanyScope, string> = {
  all: 'All Orgs',
  prospects: 'Prospects',
  vc_fund: 'Investors',
  unknown: 'Unknown'
}

const ENTITY_TYPES: { value: CompanyEntityType; label: string }[] = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'pass', label: 'Pass' },
  { value: 'vc_fund', label: 'Investor' },
  { value: 'customer', label: 'Customer' },
  { value: 'partner', label: 'Partner' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'other', label: 'Other' }
]

const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

const PRIORITIES: { value: CompanyPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'further_work', label: 'Further Work' },
  { value: 'monitor', label: 'Monitor' }
]

const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
]

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

function formatLastTouch(value: string | null): string {
  if (!value) return ''
  const timestamp = parseTimestamp(value)
  if (Number.isNaN(timestamp)) return ''
  const date = new Date(timestamp)
  const diffDays = Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS))
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

function buildFilter(query: string, scope: CompanyScope, sortBy: CompanySortBy): CompanyListFilter {
  const filter: CompanyListFilter = {
    query: query.trim(),
    limit: 400,
    sortBy,
    includeStats: true
  }

  if (scope === 'prospects') {
    filter.view = 'all'
    filter.entityTypes = ['prospect']
    return filter
  }

  filter.view = 'all'
  if (scope === 'vc_fund') filter.entityTypes = ['vc_fund']
  if (scope === 'unknown') filter.entityTypes = ['unknown']
  return filter
}

export default function Companies() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { enabled: companiesEnabled, loading: flagsLoading } = useFeatureFlag('ff_companies_ui_v1')
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<CompanyScope>('all')
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [newCity, setNewCity] = useState('')
  const [newState, setNewState] = useState('')
  const [newEntityType, setNewEntityType] = useState<CompanyEntityType>('unknown')
  const [newPipelineStage, setNewPipelineStage] = useState<CompanyPipelineStage | ''>('')
  const [newPriority, setNewPriority] = useState<CompanyPriority | ''>('')
  const [newRound, setNewRound] = useState<CompanyRound | ''>('')
  const [newPostMoney, setNewPostMoney] = useState('')
  const [newRaiseSize, setNewRaiseSize] = useState('')
  const [newContactName, setNewContactName] = useState('')
  const [newContactEmail, setNewContactEmail] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const bulkMenuRef = useRef<HTMLDivElement>(null)
  const createCardRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const query = (searchParams.get('q') || '').trim()
  const showCreate = searchParams.get('new') === '1'
  const rawSort = (searchParams.get('sort') || '').trim()
  const sortBy: CompanySortBy = rawSort === 'name' || rawSort === 'recent_touch'
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

  const setSort = useCallback((nextSort: CompanySortBy) => {
    const next = new URLSearchParams(searchParams)
    if (nextSort === 'recent_touch') {
      next.delete('sort')
    } else {
      next.set('sort', nextSort)
    }
    setSearchParams(next)
  }, [searchParams, setSearchParams])

  const fetchCompanies = useCallback(async () => {
    if (!companiesEnabled) return
    setLoading(true)
    setError(null)
    try {
      const results = await window.api.invoke<CompanySummary[]>(
        IPC_CHANNELS.COMPANY_LIST,
        buildFilter(query, scope, sortBy)
      )
      setCompanies(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [companiesEnabled, query, scope, sortBy])

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!query) {
      fetchCompanies()
      return
    }
    searchDebounceRef.current = setTimeout(() => {
      fetchCompanies()
    }, 300)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [fetchCompanies])

  const resetNewForm = useCallback(() => {
    setNewName('')
    setNewDescription('')
    setNewDomain('')
    setNewCity('')
    setNewState('')
    setNewEntityType('unknown')
    setNewPipelineStage('')
    setNewPriority('')
    setNewRound('')
    setNewPostMoney('')
    setNewRaiseSize('')
    setNewContactName('')
    setNewContactEmail('')
  }, [])

  useEffect(() => {
    if (!showCreate) return
    createCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showCreate])

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
          window.api.invoke(IPC_CHANNELS.COMPANY_DELETE, id)
        )
      )
      setSelectedIds(new Set())
      await fetchCompanies()
    } catch (err) {
      setError(String(err))
    } finally {
      setBulkDeleting(false)
    }
  }, [selectedIds, bulkDeleting, fetchCompanies])

  const handleCreateCompany = async () => {
    if (!newName.trim()) return
    try {
      const created = await window.api.invoke<CompanySummary>(
        IPC_CHANNELS.COMPANY_CREATE,
        {
          canonicalName: newName.trim(),
          description: newDescription.trim() || null,
          primaryDomain: newDomain.trim() || null,
          entityType: newEntityType,
          primaryContact: newContactName.trim() && newContactEmail.trim()
            ? { fullName: newContactName.trim(), email: newContactEmail.trim() }
            : undefined
        }
      )
      const updates: Record<string, unknown> = {}
      if (newCity.trim()) updates.city = newCity.trim()
      if (newState.trim()) updates.state = newState.trim()
      if (newPipelineStage) updates.pipelineStage = newPipelineStage
      if (newPriority) updates.priority = newPriority
      if (newRound) updates.round = newRound
      if (newPostMoney.trim()) updates.postMoneyValuation = Number(newPostMoney)
      if (newRaiseSize.trim()) updates.raiseSize = Number(newRaiseSize)
      if (Object.keys(updates).length > 0) {
        await window.api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, updates)
      }
      closeCreateForm()
      resetNewForm()
      await fetchCompanies()
      navigate(`/company/${created.id}`)
    } catch (err) {
      setError(String(err))
    }
  }

  if (!flagsLoading && !companiesEnabled) {
    return (
      <EmptyState
        title="Companies disabled"
        description="Enable the companies feature flag in Settings to use this page."
      />
    )
  }

  const showEmptyState = !loading && companies.length === 0 && !query && !showCreate

  const virtualizer = useVirtualizer({
    count: companies.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 5
  })

  return (
    <div className={styles.container}>
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
      <div className={styles.controlsRow}>
        <div className={styles.sortGroup}>
          <label htmlFor="company-sort" className={styles.sortLabel}>Sort</label>
          <select
            id="company-sort"
            className={styles.sortSelect}
            value={sortBy}
            onChange={(e) => setSort(e.target.value as CompanySortBy)}
          >
            <option value="recent_touch">Recent touch</option>
            <option value="name">Name (A-Z)</option>
          </select>
        </div>
      </div>

      {showCreate && (
        <div ref={createCardRef} className={styles.createCard}>
          <div className={styles.createFormGrid}>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Company Name</label>
              <input className={styles.input} value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
            </div>
            <div>
              <label className={styles.createLabel}>Domain</label>
              <input className={styles.input} placeholder="e.g. acme.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>City</label>
              <input className={styles.input} value={newCity} onChange={(e) => setNewCity(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>State</label>
              <input className={styles.input} placeholder="e.g. CA" value={newState} onChange={(e) => setNewState(e.target.value)} />
            </div>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Description</label>
              <textarea className={styles.textarea} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Entity Type</label>
              <select className={styles.createSelect} value={newEntityType} onChange={(e) => setNewEntityType(e.target.value as CompanyEntityType)}>
                {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Pipeline Stage</label>
              <select className={styles.createSelect} value={newPipelineStage} onChange={(e) => setNewPipelineStage(e.target.value as CompanyPipelineStage | '')}>
                <option value="">None</option>
                {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Priority</label>
              <select className={styles.createSelect} value={newPriority} onChange={(e) => setNewPriority(e.target.value as CompanyPriority | '')}>
                <option value="">None</option>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Round</label>
              <select className={styles.createSelect} value={newRound} onChange={(e) => setNewRound(e.target.value as CompanyRound | '')}>
                <option value="">None</option>
                {ROUNDS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Post Money ($M)</label>
              <input className={styles.input} type="number" step="0.1" value={newPostMoney} onChange={(e) => setNewPostMoney(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Raise Size ($M)</label>
              <input className={styles.input} type="number" step="0.1" value={newRaiseSize} onChange={(e) => setNewRaiseSize(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Primary Contact Name</label>
              <input className={styles.input} placeholder="e.g. Jane Smith" value={newContactName} onChange={(e) => setNewContactName(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Primary Contact Email</label>
              <input className={styles.input} placeholder="e.g. jane@acme.com" value={newContactEmail} onChange={(e) => setNewContactEmail(e.target.value)} />
            </div>
          </div>
          <div className={styles.createActions}>
            <button className={styles.createBtn} onClick={handleCreateCompany} disabled={!newName.trim()}>Create</button>
            <button className={styles.createCancelBtn} onClick={closeCreateForm}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {query && (
        <p className={styles.resultCount}>
          {loading ? 'Searching...' : `${companies.length} result${companies.length !== 1 ? 's' : ''}`}
        </p>
      )}

      <div className={styles.scrollArea} ref={scrollRef}>
        {showEmptyState ? (
          <EmptyState
            title="No companies yet"
            description="Companies are auto-detected from meeting attendees, or you can add one manually."
            action={{ label: '+ New Company', onClick: openCreateForm }}
          />
        ) : (
          <>
            <div className={styles.section}>
              <h3 className={styles.sectionHeader}>
                {SCOPE_LABELS[scope]} ({companies.length})
              </h3>
              <div className={styles.list} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vrow) => {
                  const company = companies[vrow.index]
                  const touchDays = daysSince(company.lastTouchpoint)
                  const warmthClass = touchDays == null
                    ? styles.warmthUnknown
                    : touchDays < 14
                        ? styles.warmthGreen
                        : touchDays <= 30
                            ? styles.warmthYellow
                            : styles.warmthRed
                  const isSelected = selectedIds.has(company.id)
                  return (
                    <div
                      key={company.id}
                      style={{ position: 'absolute', top: vrow.start, left: 0, right: 0 }}
                      className={`${styles.cardWrapper} ${isSelected ? styles.cardWrapperSelected : ''}`}
                    >
                      <div
                        className={styles.checkboxZone}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(company.id)) next.delete(company.id)
                            else next.add(company.id)
                            return next
                          })
                        }}
                      >
                        <input
                          type="checkbox"
                          className={styles.companyCheckbox}
                          checked={isSelected}
                          onChange={() => {}}
                          tabIndex={-1}
                        />
                      </div>
                      <div
                        className={styles.card}
                        onClick={() => navigate(`/company/${company.id}`)}
                      >
                        <div className={styles.cardRow}>
                          <div className={styles.cardNameGroup}>
                            {company.primaryDomain && (
                              <img
                                src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.primaryDomain)}&sz=32`}
                                alt=""
                                className={styles.favicon}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            )}
                            <span className={styles.cardName}>{company.canonicalName}</span>
                          </div>
                          <span className={styles.cardDomain}>{company.primaryDomain || ''}</span>
                        </div>
                        <div className={styles.cardRow}>
                          <span className={styles.cardMeta}>
                            {[
                              company.meetingCount > 0 && `${company.meetingCount} meeting${company.meetingCount !== 1 ? 's' : ''}`,
                              company.emailCount > 0 && `${company.emailCount} email${company.emailCount !== 1 ? 's' : ''}`
                            ].filter(Boolean).join(', ') || 'No activity'}
                          </span>
                          <div className={styles.touchMeta}>
                            <span className={styles.cardStage}>
                              {formatLastTouch(company.lastTouchpoint)}
                            </span>
                            <span className={`${styles.warmthBadge} ${warmthClass}`}>
                              {touchDays == null ? '--' : `${touchDays}d`}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {!loading && companies.length === 0 && query && (
              <p className={styles.noResults}>No companies match your search.</p>
            )}
          </>
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
                  Delete {selectedIds.size} compan{selectedIds.size !== 1 ? 'ies' : 'y'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
