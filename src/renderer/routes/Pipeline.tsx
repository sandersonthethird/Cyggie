import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type {
  CompanySummary,
  CompanyEntityType,
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
        if (aV == null) return 1   // null always last — bypass direction multiplier
        if (bV == null) return -1
        cmp = aV - bV
        break
      }
      case 'raiseSize': {
        const aV = a.raiseSize, bV = b.raiseSize
        if (aV == null && bV == null) break
        if (aV == null) return 1   // null always last
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
  return PRIORITIES.find((p) => p.value === value)?.label || value
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
  const [addToSyncCompany, setAddToSyncCompany] = useState<CompanySummary | null>(null)
  const [createName, setCreateName] = useState('')
  const [createDomain, setCreateDomain] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createCity, setCreateCity] = useState('')
  const [createState, setCreateState] = useState('')
  const [createEntityType, setCreateEntityType] = useState<CompanyEntityType>('unknown')
  const [createPipelineStage, setCreatePipelineStage] = useState<CompanyPipelineStage | ''>('screening')
  const [createPriority, setCreatePriority] = useState<CompanyPriority | ''>('')
  const [createRound, setCreateRound] = useState<CompanyRound | ''>('')
  const [createPostMoney, setCreatePostMoney] = useState('')
  const [createRaiseSize, setCreateRaiseSize] = useState('')

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

  // Load pass expiry preference once on mount
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

  const resetCreateForm = useCallback(() => {
    setCreateName('')
    setCreateDomain('')
    setCreateDescription('')
    setCreateCity('')
    setCreateState('')
    setCreateEntityType('unknown')
    setCreatePipelineStage('screening')
    setCreatePriority('')
    setCreateRound('')
    setCreatePostMoney('')
    setCreateRaiseSize('')
  }, [])

  const createCompany = useCallback(async () => {
    if (!createName.trim()) return
    try {
      const created = await api.invoke<CompanySummary>(
        IPC_CHANNELS.COMPANY_CREATE,
        {
          canonicalName: createName.trim(),
          description: createDescription.trim() || null,
          primaryDomain: createDomain.trim() || null,
          entityType: createEntityType
        }
      )
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, {
        city: createCity.trim() || null,
        state: createState.trim() || null,
        pipelineStage: (createPipelineStage || null) as CompanyPipelineStage | null,
        priority: (createPriority || null) as CompanyPriority | null,
        round: (createRound || null) as CompanyRound | null,
        postMoneyValuation: createPostMoney.trim() ? Number(createPostMoney) : null,
        raiseSize: createRaiseSize.trim() ? Number(createRaiseSize) : null
      })
      resetCreateForm()
      setShowCreate(false)
      await loadData()
    } catch (err) {
      setError(String(err))
    }
  }, [createName, createDescription, createDomain, createCity, createState, createEntityType, createPipelineStage, createPriority, createRound, createPostMoney, createRaiseSize, resetCreateForm, loadData])

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

  if (loading && companies.length === 0) {
    return <div className={styles.page}>Loading pipeline...</div>
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Pipeline</h1>
        <button
          className={styles.primaryButton}
          onClick={() => setShowCreate((v) => !v)}
        >
          + Company
        </button>
      </div>

      {showCreate && (
        <div className={styles.createCard}>
          <div className={styles.createFormGrid}>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Company Name</label>
              <input className={styles.createInput} value={createName} onChange={(e) => setCreateName(e.target.value)} autoFocus />
            </div>
            <div>
              <label className={styles.createLabel}>Domain</label>
              <input className={styles.createInput} placeholder="e.g. acme.com" value={createDomain} onChange={(e) => setCreateDomain(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>City</label>
              <input className={styles.createInput} value={createCity} onChange={(e) => setCreateCity(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>State</label>
              <input className={styles.createInput} placeholder="e.g. CA" value={createState} onChange={(e) => setCreateState(e.target.value)} />
            </div>
            <div className={styles.createFieldFull}>
              <label className={styles.createLabel}>Description</label>
              <textarea className={styles.createTextarea} value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Entity Type</label>
              <select className={styles.createSelect} value={createEntityType} onChange={(e) => setCreateEntityType(e.target.value as CompanyEntityType)}>
                {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Pipeline Stage</label>
              <select className={styles.createSelect} value={createPipelineStage} onChange={(e) => setCreatePipelineStage(e.target.value as CompanyPipelineStage | '')}>
                <option value="">None</option>
                {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Priority</label>
              <select className={styles.createSelect} value={createPriority} onChange={(e) => setCreatePriority(e.target.value as CompanyPriority | '')}>
                <option value="">None</option>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Round</label>
              <select className={styles.createSelect} value={createRound} onChange={(e) => setCreateRound(e.target.value as CompanyRound | '')}>
                <option value="">None</option>
                {ROUNDS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.createLabel}>Post Money ($M)</label>
              <input className={styles.createInput} type="number" step="0.1" value={createPostMoney} onChange={(e) => setCreatePostMoney(e.target.value)} />
            </div>
            <div>
              <label className={styles.createLabel}>Raise Size ($M)</label>
              <input className={styles.createInput} type="number" step="0.1" value={createRaiseSize} onChange={(e) => setCreateRaiseSize(e.target.value)} />
            </div>
          </div>
          <div className={styles.createActions}>
            <button className={styles.primaryButton} onClick={() => void createCompany()} disabled={!createName.trim()}>Create</button>
            <button className={styles.linkButton} onClick={() => { setShowCreate(false); resetCreateForm() }}>Cancel</button>
          </div>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.board}>
        {STAGES.map((stage) => {
          const stageCompanies = companies.filter((c) => c.pipelineStage === stage.value)
          return (
            <div
              key={stage.value}
              className={styles.column}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
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
                    className={styles.companyCard}
                    draggable
                    onDragStart={() => setDragCompanyId(company.id)}
                  >
                    <button
                      className={styles.cardNameButton}
                      onClick={() => navigate(`/company/${company.id}`)}
                    >
                      {company.canonicalName}
                    </button>
                    <div className={styles.cardBadges}>
                      {company.priority && (
                        <span className={`${styles.priorityBadge} ${PRIORITY_STYLE[company.priority] ?? ''}`}>
                          {formatPriority(company.priority)}
                        </span>
                      )}
                      {company.round && (
                        <span className={`${styles.roundBadge} ${ROUND_STYLE[company.round] ?? ''}`}>
                          {formatRound(company.round)}
                        </span>
                      )}
                    </div>
                    <div className={styles.cardMeta}>
                      {formatLastTouch(company.lastTouchpoint)}
                    </div>
                    {(company.postMoneyValuation != null || company.raiseSize != null) && (
                      <div className={styles.cardMeta}>
                        {company.postMoneyValuation != null && `Val: ${formatMoney(company.postMoneyValuation)}`}
                        {company.postMoneyValuation != null && company.raiseSize != null && ' · '}
                        {company.raiseSize != null && `Raise: ${formatMoney(company.raiseSize)}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.pipelineTable}>
          <thead>
            <tr>
              <th className={styles.companyColumn}>
                <div className={styles.thContent}>
                  <span className={styles.thSortLabel} onClick={() => handleSort('name')}>
                    Company {sortIcon('name')}
                  </span>
                  <input
                    className={styles.thSearchInput}
                    placeholder="Search…"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                  />
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
              <th className={styles.sortableTh} onClick={() => handleSort('postMoney')}>
                Post Money {sortIcon('postMoney')}
              </th>
              <th className={styles.sortableTh} onClick={() => handleSort('raiseSize')}>
                Raise Size {sortIcon('raiseSize')}
              </th>
              <th>Description</th>
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
                    value={company.priority}
                    options={priorityOptions}
                    colorMap={PRIORITY_STYLE}
                    onChange={(v) => void updateCompanyField(company.id, 'priority', v)}
                    onAddOption={priorityDef ? async (opt) => addCustomFieldOption(priorityDef.id, priorityDef.optionsJson, opt) : undefined}
                  />
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
                    value={company.postMoneyValuation ?? ''}
                    onChange={(e) => {
                      const val = e.target.value.trim()
                      void updateCompanyField(company.id, 'postMoneyValuation', val ? Number(val) : null)
                    }}
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
                <td className={styles.descriptionCell}>
                  {company.description || '-'}
                </td>
              </tr>
            ))}
            {filteredCompanies.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  {companies.length === 0
                    ? 'No companies in pipeline yet. Add one above.'
                    : 'No companies match the current filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
