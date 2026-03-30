import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import NewCompanyModal from '../components/company/NewCompanyModal'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type {
  CompanySummary,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound
} from '../../shared/types/company'
import { AddToSyncModal } from '../components/partner-meeting/AddToSyncModal'
import ChatInterface from '../components/chat/ChatInterface'
import MultiSelectFilter from '../components/common/MultiSelectFilter'
import { DecisionLogModal } from '../components/crm/DecisionLogModal'
import { AddOptionInlineInput } from '../components/crm/AddOptionInlineInput'
import { shouldPromptDecisionLog, defaultDecisionType } from '../utils/decisionLogTrigger'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import { usePreferencesStore } from '../stores/preferences.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../utils/customFieldUtils'
import styles from './Pipeline.module.css'
import { api } from '../api'

const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

const PRIORITIES: { value: CompanyPriority; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: '#2d8a4e' },
  { value: 'further_work', label: 'Further Work', color: '#c49a0b' },
  { value: 'monitor', label: 'Monitor', color: '#c0392b' }
]

const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
]

// Derived sort orders — automatically track array order
const STAGE_ORDER = Object.fromEntries(STAGES.map((s, i) => [s.value, i]))
const PRIORITY_ORDER = Object.fromEntries(PRIORITIES.map((p, i) => [p.value, i]))
const ROUND_ORDER = Object.fromEntries(ROUNDS.map((r, i) => [r.value, i]))

const PRIORITY_LABELS: Record<string, string> = {
  high:         'High',
  further_work: 'Further Work',
  monitor:      'Monitor',
}

/** Pure sort function — exported for unit testing */
export function sortCompanies(
  companies: CompanySummary[],
  column: string,
  direction: 'asc' | 'desc'
): CompanySummary[] {
  return [...companies].sort((a, b) => {
    let cmp = 0
    switch (column) {
      case 'name':
        cmp = (a.canonicalName ?? '').localeCompare(b.canonicalName ?? '')
        break
      case 'priority':
        cmp = (PRIORITY_ORDER[a.priority ?? ''] ?? 99) - (PRIORITY_ORDER[b.priority ?? ''] ?? 99)
        break
      case 'stage':
        cmp = (STAGE_ORDER[a.pipelineStage ?? ''] ?? 99) - (STAGE_ORDER[b.pipelineStage ?? ''] ?? 99)
        break
      case 'round':
        cmp = (ROUND_ORDER[a.round ?? ''] ?? 99) - (ROUND_ORDER[b.round ?? ''] ?? 99)
        break
      case 'postMoney': {
        const aV = a.postMoneyValuation, bV = b.postMoneyValuation
        if (aV == null && bV == null) break
        if (aV == null) return 1
        if (bV == null) return -1
        cmp = aV - bV
        break
      }
      case 'raiseSize': {
        const aV = a.raiseSize, bV = b.raiseSize
        if (aV == null && bV == null) break
        if (aV == null) return 1
        if (bV == null) return -1
        cmp = aV - bV
        break
      }
    }
    return direction === 'asc' ? cmp : -cmp
  })
}

function formatPriority(value: CompanyPriority | null): string {
  if (!value) return '-'
  return PRIORITY_LABELS[value] ?? value
}

function formatRound(value: CompanyRound | null): string {
  if (!value) return '-'
  return ROUNDS.find((r) => r.value === value)?.label || value
}

function formatMoney(value: number | null): string {
  if (value == null) return '-'
  return `$${value}M`
}

const PRIORITY_STYLE: Record<string, string> = {
  high:         styles.priorityHigh,
  further_work: styles.priorityFurtherWork,
  monitor:      styles.priorityMonitor,
}

// Left-border color class per priority (applied to card wrapper)
const CARD_PRIORITY_STYLE: Record<string, string> = {
  high:         styles.cardBorderHigh,
  further_work: styles.cardBorderFurtherWork,
  monitor:      styles.cardBorderMonitor,
}

const STAGE_STYLE: Record<string, string> = {
  screening:     styles.chipScreening,
  diligence:     styles.chipDiligence,
  decision:      styles.chipDecision,
  documentation: styles.chipDocumentation,
  pass:          styles.chipPass,
}

const ROUND_STYLE: Record<string, string> = {
  pre_seed:       styles.chipPreSeed,
  seed:           styles.chipSeed,
  seed_extension: styles.chipSeedExtension,
  series_a:       styles.chipSeriesA,
  series_b:       styles.chipSeriesB,
}

interface ChipDropdownCellProps {
  value: string | null
  options: { value: string; label: string }[]
  colorMap: Record<string, string>
  onChange: (v: string | null) => void
  onAddOption?: (opt: string) => Promise<void>
}

function ChipDropdownCell({ value, options, colorMap, onChange, onAddOption }: ChipDropdownCellProps) {
  const [addingOption, setAddingOption] = useState(false)
  const label = value ? (options.find(o => o.value === value)?.label ?? value) : '—'
  const chipClass = value ? (colorMap[value] ?? '') : ''

  if (addingOption && onAddOption) {
    return (
      <AddOptionInlineInput
        className={styles.chipCellInput}
        onConfirm={async (opt) => {
          setAddingOption(false)
          await onAddOption(opt)
          onChange(opt)
        }}
        onCancel={() => setAddingOption(false)}
      />
    )
  }

  return (
    <div className={`${styles.chipCell} ${chipClass}`}>
      <span>{label}</span>
      <span className={styles.chipCellCaret}>▾</span>
      <select
        className={styles.chipCellSelect}
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__add_option__') {
            setAddingOption(true)
            return
          }
          onChange(e.target.value || null)
        }}
      >
        <option value="">—</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        {onAddOption && <option value="__add_option__">+ Add option…</option>}
      </select>
    </div>
  )
}

function formatLastTouch(value: string | null): string {
  if (!value) return 'No touchpoint'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No touchpoint'
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'Today'
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

const DEFAULT_PASS_EXPIRY_DAYS = 30

function passExpiryCutoff(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

// ── KpiCard ────────────────────────────────────────────────────────────────

interface KpiCardProps {
  title: string
  value: number
  subtitle: string
  crimson?: boolean
}

function KpiCard({ title, value, subtitle, crimson }: KpiCardProps) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiTitle}>{title}</div>
      <div className={`${styles.kpiValue} ${crimson ? styles.kpiValueCrimson : ''}`}>{value}</div>
      <div className={styles.kpiSubtitle}>{subtitle}</div>
    </div>
  )
}

// ── AddDealModal ───────────────────────────────────────────────────────────

interface AddDealModalProps {
  onClose: () => void
  onCreated: () => void
}

function AddDealModal({ onClose, onCreated }: AddDealModalProps) {
  const [name, setName] = useState('')
  const [stage, setStage] = useState<CompanyPipelineStage>('screening')
  const [priority, setPriority] = useState<CompanyPriority>('high')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    let created: CompanySummary | null = null
    try {
      created = await api.invoke<CompanySummary>(IPC_CHANNELS.COMPANY_CREATE, { canonicalName: name.trim() })
    } catch {
      setError('Failed to create company.')
      setSubmitting(false)
      return
    }
    // Best-effort: assign stage + priority — if this fails the company still exists
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, { pipelineStage: stage, priority })
    } catch {
      // company exists; user can set stage/priority manually
    }
    onCreated()
    onClose()
  }

  return createPortal(
    <div
      className={styles.modalBackdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles.modal}>
        <div className={styles.modalTitle}>New Deal</div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Company Name</label>
            <input
              autoFocus
              className={styles.modalInput}
              placeholder="e.g. Acme Corp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Initial Stage</label>
            <select
              className={styles.modalInput}
              value={stage}
              onChange={(e) => setStage(e.target.value as CompanyPipelineStage)}
              disabled={submitting}
            >
              <option value="screening">Screening</option>
              <option value="diligence">Diligence</option>
              <option value="decision">Decision</option>
              <option value="documentation">Documentation</option>
            </select>
          </div>
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Priority</label>
            <select
              className={styles.modalInput}
              value={priority}
              onChange={(e) => setPriority(e.target.value as CompanyPriority)}
              disabled={submitting}
            >
              <option value="high">High</option>
              <option value="further_work">Further Work</option>
              <option value="monitor">Monitor</option>
            </select>
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
          <div className={styles.modalActions}>
            <button type="button" className={styles.modalCancel} onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className={styles.modalSubmit} disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create Deal'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// ── Pipeline ───────────────────────────────────────────────────────────────

export default function Pipeline() {
  const navigate = useNavigate()
  const { companyDefs, load, loaded } = useCustomFieldStore()
  const { getJSON, setJSON } = usePreferencesStore()

  useEffect(() => { if (!loaded) load() }, [loaded, load])

  const stageDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'pipelineStage')
  const priorityDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'priority')
  const roundDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === 'round')
  const stageOptions = mergeBuiltinOptions(STAGES, stageDef?.optionsJson ?? null)
  const priorityOptions = mergeBuiltinOptions(PRIORITIES, priorityDef?.optionsJson ?? null)
  const roundOptions = mergeBuiltinOptions(ROUNDS, roundDef?.optionsJson ?? null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [passExpiryDays, setPassExpiryDays] = useState(DEFAULT_PASS_EXPIRY_DAYS)
  const [dragCompanyId, setDragCompanyId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createDefaultStage, setCreateDefaultStage] = useState<CompanyPipelineStage | undefined>(undefined)
  const [createInitialPdfPath, setCreateInitialPdfPath] = useState<string | undefined>(undefined)
  const [addToSyncCompany, setAddToSyncCompany] = useState<CompanySummary | null>(null)
  const [fileDropTargetStage, setFileDropTargetStage] = useState<CompanyPipelineStage | null>(null)

  // View toggle — persisted to preferences
  const [view, setView] = useState<'board' | 'table'>(() =>
    getJSON<'board' | 'table'>('cyggie:pipeline-view', 'board')
  )
  useEffect(() => { setJSON('cyggie:pipeline-view', view) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  // AddDeal modal
  const [addDealOpen, setAddDealOpen] = useState(false)

  // Table filters — persisted to preferences. Default excludes 'pass'.
  const [filterStages, setFilterStages] = useState<Set<CompanyPipelineStage>>(() => {
    const stored = getJSON<string[] | null>('cyggie:pipeline-filter-stages', null)
    return stored !== null
      ? new Set(stored as CompanyPipelineStage[])
      : new Set<CompanyPipelineStage>(['screening', 'diligence', 'decision', 'documentation'])
  })
  const [filterPriorities, setFilterPriorities] = useState<Set<CompanyPriority>>(() =>
    new Set(getJSON<string[]>('cyggie:pipeline-filter-priorities', []) as CompanyPriority[])
  )
  const [filterRounds, setFilterRounds] = useState<Set<CompanyRound>>(() =>
    new Set(getJSON<string[]>('cyggie:pipeline-filter-rounds', []) as CompanyRound[])
  )
  const [filterQuery, setFilterQuery] = useState('')
  const [pendingDecisionCompany, setPendingDecisionCompany] =
    useState<{ id: string; stage: CompanyPipelineStage; entityType: string } | null>(null)

  // Sort state — persisted to preferences
  const [sortColumn, setSortColumn] = useState<string | null>(() =>
    getJSON<string | null>('cyggie:pipeline-sort-column', null)
  )
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() =>
    getJSON<'asc' | 'desc'>('cyggie:pipeline-sort-direction', 'asc')
  )

  // Persist filter/sort state on change
  useEffect(() => { setJSON('cyggie:pipeline-filter-stages', [...filterStages]) }, [filterStages]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setJSON('cyggie:pipeline-filter-priorities', [...filterPriorities]) }, [filterPriorities]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setJSON('cyggie:pipeline-filter-rounds', [...filterRounds]) }, [filterRounds]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setJSON('cyggie:pipeline-sort-column', sortColumn) }, [sortColumn]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setJSON('cyggie:pipeline-sort-direction', sortDirection) }, [sortDirection]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const pipelineData = await api.invoke<CompanySummary[]>(IPC_CHANNELS.PIPELINE_LIST, {
        passExpiryBefore: passExpiryCutoff(passExpiryDays)
      })
      setCompanies(pipelineData)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [passExpiryDays])

  useEffect(() => {
    api.invoke<Record<string, string>>(IPC_CHANNELS.SETTINGS_GET_ALL)
      .then((all) => {
        const days = parseInt(all?.pipelinePassExpiryDays || String(DEFAULT_PASS_EXPIRY_DAYS), 10)
        if (!isNaN(days) && days > 0) setPassExpiryDays(days)
      })
      .catch(() => {/* keep default */})
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const openCreate = useCallback((stage?: CompanyPipelineStage, pdfPath?: string) => {
    setCreateDefaultStage(stage)
    setCreateInitialPdfPath(pdfPath)
    setShowCreate(true)
  }, [])

  const closeCreate = useCallback(() => {
    setShowCreate(false)
    setCreateDefaultStage(undefined)
    setCreateInitialPdfPath(undefined)
  }, [])

  const handleCompanyCreated = useCallback(async (company: CompanySummary) => {
    closeCreate()
    await loadData()
    navigate(`/company/${company.id}`)
  }, [closeCreate, loadData, navigate])

  const updateCompanyField = useCallback(async (
    companyId: string,
    field: string,
    value: string | number | null
  ) => {
    const company = companies.find(c => c.id === companyId)
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, companyId, {
        [field]: value || null
      })
      await loadData()
      if (field === 'pipelineStage' && company && typeof value === 'string') {
        if (shouldPromptDecisionLog(company.pipelineStage, value as CompanyPipelineStage, company.entityType, company.entityType)) {
          setPendingDecisionCompany({ id: companyId, stage: value as CompanyPipelineStage, entityType: company.entityType })
        }
      }
    } catch (err) {
      setError(String(err))
    }
  }, [companies, loadData])

  const moveToStage = useCallback(async (companyId: string, stage: CompanyPipelineStage) => {
    const company = companies.find(c => c.id === companyId)
    try {
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, companyId, {
        pipelineStage: stage
      })
      await loadData()
      if (company && shouldPromptDecisionLog(company.pipelineStage, stage, company.entityType, company.entityType)) {
        setPendingDecisionCompany({ id: companyId, stage, entityType: company.entityType })
      }
    } catch (err) {
      setError(String(err))
    }
  }, [companies, loadData])

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const sortIcon = (column: string) => {
    if (sortColumn !== column) return <span className={styles.sortIcon}>⇅</span>
    return <span className={styles.sortIconActive}>{sortDirection === 'asc' ? '↑' : '↓'}</span>
  }

  const filteredCompanies = useMemo(() => {
    let result = companies
    if (filterStages.size > 0) result = result.filter((c) => c.pipelineStage != null && filterStages.has(c.pipelineStage))
    if (filterPriorities.size > 0) result = result.filter((c) => c.priority != null && filterPriorities.has(c.priority))
    if (filterRounds.size > 0) result = result.filter((c) => c.round != null && filterRounds.has(c.round))
    if (filterQuery.trim()) {
      const q = filterQuery.trim().toLowerCase()
      result = result.filter((c) =>
        c.canonicalName.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
      )
    }
    if (sortColumn) {
      result = sortCompanies(result, sortColumn, sortDirection)
    }
    return result
  }, [companies, filterStages, filterPriorities, filterRounds, filterQuery, sortColumn, sortDirection])

  // KPI: all non-pass companies, unaffected by filter state
  const allActiveCompanies = useMemo(() =>
    companies.filter(c => c.pipelineStage !== 'pass'),
  [companies])

  const kpiStats = useMemo(() => ({
    total:     allActiveCompanies.length,
    diligence: allActiveCompanies.filter(c => c.pipelineStage === 'diligence').length,
    decision:  allActiveCompanies.filter(c => c.pipelineStage === 'decision').length,
  }), [allActiveCompanies])

  if (loading && companies.length === 0) {
    return <div className={styles.page}>Loading pipeline...</div>
  }

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <h1 className={styles.pageTitle}>Active Pipeline</h1>
        <div className={styles.topBarActions}>
          <input
            className={styles.headerSearch}
            placeholder="Search companies…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
          <MultiSelectFilter
            options={stageOptions}
            selected={filterStages}
            onChange={setFilterStages}
            allLabel="All"
            fixedLabel="Stage"
            variant="header"
            portal
          />
          <MultiSelectFilter
            options={priorityOptions}
            selected={filterPriorities}
            onChange={setFilterPriorities}
            allLabel="All"
            fixedLabel="Priority"
            variant="header"
            portal
          />
          <MultiSelectFilter
            options={roundOptions}
            selected={filterRounds}
            onChange={setFilterRounds}
            allLabel="All"
            fixedLabel="Round"
            variant="header"
            portal
          />
          <div className={styles.viewToggle}>
            <button
              className={view === 'board' ? styles.viewToggleActive : styles.viewToggleInactive}
              onClick={() => setView('board')}
            >
              Kanban
            </button>
            <button
              className={view === 'table' ? styles.viewToggleActive : styles.viewToggleInactive}
              onClick={() => setView('table')}
            >
              Table
            </button>
          </div>
          <button className={styles.addDealBtn} onClick={() => setAddDealOpen(true)}>
            + Deal
          </button>
        </div>
      </div>

      {/* KPI row — always visible, uses all non-pass companies */}
      <div className={styles.kpiRow}>
        <KpiCard title="Active Deals"       value={kpiStats.total}     subtitle="Across all active stages" />
        <KpiCard title="In Diligence"       value={kpiStats.diligence} subtitle="In active diligence" />
        <KpiCard title="Requiring Decision" value={kpiStats.decision}  subtitle="Awaiting partner review"
                 crimson={kpiStats.decision > 0} />
      </div>

      <NewCompanyModal
        open={showCreate}
        defaultStage={createDefaultStage}
        initialPdfPath={createInitialPdfPath}
        onCreated={(company) => void handleCompanyCreated(company)}
        onClose={closeCreate}
      />

      {addDealOpen && (
        <AddDealModal
          onClose={() => setAddDealOpen(false)}
          onCreated={() => void loadData()}
        />
      )}

      {error && <div className={styles.error}>{error}</div>}

      {/* Kanban board — shows all companies, unaffected by filters */}
      {view === 'board' && (
        <div className={styles.board}>
          {STAGES.map((stage) => {
            const stageCompanies = companies.filter((c) => c.pipelineStage === stage.value)
            return (
              <div
                key={stage.value}
                className={`${styles.column} ${fileDropTargetStage === stage.value ? styles.fileDropTarget : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (e.dataTransfer.types.includes('Files')) {
                    setFileDropTargetStage(stage.value)
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setFileDropTargetStage(null)
                  }
                }}
                onDrop={(e) => {
                  setFileDropTargetStage(null)
                  const file = e.dataTransfer.files[0]
                  if (file && file.name.toLowerCase().endsWith('.pdf')) {
                    const filePath = (file as unknown as { path?: string }).path
                    if (filePath) {
                      openCreate(stage.value, filePath)
                      return
                    }
                  }
                  if (!dragCompanyId) return
                  void moveToStage(dragCompanyId, stage.value)
                  setDragCompanyId(null)
                }}
              >
                <div className={styles.columnHeader}>
                  <span className={styles.columnTitle}>{stage.label}</span>
                  <span className={styles.countBadge}>{stageCompanies.length}</span>
                </div>
                <div className={styles.columnBody}>
                  {stageCompanies.map((company) => (
                    <div
                      key={company.id}
                      className={`${styles.companyCard} ${company.priority ? (CARD_PRIORITY_STYLE[company.priority] ?? '') : ''}`}
                      draggable
                      onDragStart={() => setDragCompanyId(company.id)}
                      onClick={() => navigate(`/company/${company.id}`)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/company/${company.id}`) }}
                    >
                      <div className={styles.cardName}>{company.canonicalName}</div>
                      {company.description && (
                        <p className={styles.cardDesc}>{company.description}</p>
                      )}
                      <div className={styles.cardTags}>
                        {company.raiseSize != null && (
                          <span className={styles.cardTag}>{formatMoney(company.raiseSize)} Raise</span>
                        )}
                        {company.postMoneyValuation != null && (
                          <span className={styles.cardTag}>{formatMoney(company.postMoneyValuation)} Post</span>
                        )}
                      </div>
                      <div className={styles.cardLastTouch}>{formatLastTouch(company.lastTouchpoint)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Table view — uses filteredCompanies */}
      {view === 'table' && (
        <div className={styles.tableWrapper}>
          <table className={styles.pipelineTable}>
            <thead>
              <tr>
                <th className={`${styles.companyColumn} ${styles.sortableTh}`} onClick={() => handleSort('name')}>
                  Company {sortIcon('name')}
                </th>
                <th>
                  <div className={styles.thHeaderWithFilter}>
                    <MultiSelectFilter
                      options={stageOptions}
                      selected={filterStages}
                      onChange={setFilterStages}
                      allLabel="All"
                      fixedLabel="Stage"
                      variant="header"
                      portal
                    />
                    <button className={styles.sortBtn} onClick={() => handleSort('stage')} type="button">
                      {sortIcon('stage')}
                    </button>
                  </div>
                </th>
                <th>
                  <div className={styles.thHeaderWithFilter}>
                    <MultiSelectFilter
                      options={priorityOptions}
                      selected={filterPriorities}
                      onChange={setFilterPriorities}
                      allLabel="All"
                      fixedLabel="Priority"
                      variant="header"
                      portal
                    />
                    <button className={styles.sortBtn} onClick={() => handleSort('priority')} type="button">
                      {sortIcon('priority')}
                    </button>
                  </div>
                </th>
                <th>
                  <div className={styles.thHeaderWithFilter}>
                    <MultiSelectFilter
                      options={roundOptions}
                      selected={filterRounds}
                      onChange={setFilterRounds}
                      allLabel="All"
                      fixedLabel="Round"
                      variant="header"
                      portal
                    />
                    <button className={styles.sortBtn} onClick={() => handleSort('round')} type="button">
                      {sortIcon('round')}
                    </button>
                  </div>
                </th>
                <th className={styles.sortableTh} onClick={() => handleSort('raiseSize')}>
                  Raise Size {sortIcon('raiseSize')}
                </th>
                <th className={styles.sortableTh} onClick={() => handleSort('postMoney')}>
                  Post Money {sortIcon('postMoney')}
                </th>
                <th>Description</th>
                <th>Last Touch</th>
              </tr>
            </thead>
            <tbody>
              {filteredCompanies.map((company) => (
                <tr key={company.id}>
                  <td className={styles.companyColumn}>
                    <button
                      className={styles.companyLink}
                      onClick={() => navigate(`/company/${company.id}`)}
                    >
                      {company.canonicalName}
                    </button>
                    <button
                      className={styles.addToSyncBtn}
                      onClick={(e) => { e.stopPropagation(); setAddToSyncCompany(company) }}
                      title="Add to Partner Sync"
                    >
                      + Sync
                    </button>
                  </td>
                  <td>
                    <ChipDropdownCell
                      value={company.pipelineStage}
                      options={stageOptions}
                      colorMap={STAGE_STYLE}
                      onChange={(v) => void updateCompanyField(company.id, 'pipelineStage', v)}
                      onAddOption={stageDef ? async (opt) => addCustomFieldOption(stageDef.id, stageDef.optionsJson, opt) : undefined}
                    />
                  </td>
                  <td>
                    <ChipDropdownCell
                      value={company.priority}
                      options={priorityOptions}
                      colorMap={PRIORITY_STYLE}
                      onChange={(v) => void updateCompanyField(company.id, 'priority', v)}
                      onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
                    />
                  </td>
                  <td>
                    <ChipDropdownCell
                      value={company.round}
                      options={roundOptions}
                      colorMap={ROUND_STYLE}
                      onChange={(v) => void updateCompanyField(company.id, 'round', v)}
                      onAddOption={roundDef ? async (opt) => addCustomFieldOption(roundDef.id, roundDef.optionsJson, opt) : undefined}
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="number"
                      step="0.1"
                      placeholder="-"
                      value={company.raiseSize ?? ''}
                      onChange={(e) => {
                        const val = e.target.value.trim()
                        void updateCompanyField(company.id, 'raiseSize', val ? Number(val) : null)
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="number"
                      step="0.1"
                      placeholder="-"
                      value={company.postMoneyValuation ?? ''}
                      onChange={(e) => {
                        const val = e.target.value.trim()
                        void updateCompanyField(company.id, 'postMoneyValuation', val ? Number(val) : null)
                      }}
                    />
                  </td>
                  <td className={styles.descriptionCell}>
                    {company.description || '-'}
                  </td>
                  <td className={styles.lastTouchCell}>
                    {formatLastTouch(company.lastTouchpoint)}
                  </td>
                </tr>
              ))}
              {filteredCompanies.length === 0 && (
                <tr>
                  <td colSpan={8} className={styles.empty}>
                    {companies.length === 0
                      ? 'No companies in pipeline yet. Click + Deal to add one.'
                      : 'No companies match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>

      {pendingDecisionCompany && (
        <DecisionLogModal
          companyId={pendingDecisionCompany.id}
          initialDecisionType={defaultDecisionType(pendingDecisionCompany.stage, pendingDecisionCompany.entityType)}
          onClose={() => setPendingDecisionCompany(null)}
          onSaved={() => { setPendingDecisionCompany(null); void loadData() }}
        />
      )}

      {addToSyncCompany && (
        <AddToSyncModal
          company={addToSyncCompany}
          onClose={() => setAddToSyncCompany(null)}
        />
      )}
    </div>
  )
}
