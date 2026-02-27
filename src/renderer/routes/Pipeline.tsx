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
import ChatInterface from '../components/chat/ChatInterface'
import styles from './Pipeline.module.css'

const ENTITY_TYPES: { value: CompanyEntityType; label: string }[] = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'pass', label: 'Pass' },
  { value: 'vc_fund', label: 'VC Fund' },
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

function priorityClass(value: CompanyPriority | null): string {
  if (value === 'high') return styles.priorityHigh
  if (value === 'further_work') return styles.priorityFurtherWork
  if (value === 'monitor') return styles.priorityMonitor
  return ''
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

export default function Pipeline() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [dragCompanyId, setDragCompanyId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
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

  // Table filters
  const [filterStage, setFilterStage] = useState<CompanyPipelineStage | ''>('')
  const [filterPriority, setFilterPriority] = useState<CompanyPriority | ''>('')
  const [filterRound, setFilterRound] = useState<CompanyRound | ''>('')
  const [filterQuery, setFilterQuery] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const pipelineData = await window.api.invoke<CompanySummary[]>(IPC_CHANNELS.PIPELINE_LIST)
      setCompanies(pipelineData)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
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
      const created = await window.api.invoke<CompanySummary>(
        IPC_CHANNELS.COMPANY_CREATE,
        {
          canonicalName: createName.trim(),
          description: createDescription.trim() || null,
          primaryDomain: createDomain.trim() || null,
          entityType: createEntityType
        }
      )
      await window.api.invoke(IPC_CHANNELS.COMPANY_UPDATE, created.id, {
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
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_UPDATE, companyId, {
        [field]: value || null
      })
      await loadData()
    } catch (err) {
      setError(String(err))
    }
  }, [loadData])

  const moveToStage = useCallback(async (companyId: string, stage: CompanyPipelineStage) => {
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_UPDATE, companyId, {
        pipelineStage: stage
      })
      await loadData()
    } catch (err) {
      setError(String(err))
    }
  }, [loadData])

  const filteredCompanies = useMemo(() => {
    let result = companies
    if (filterStage) result = result.filter((c) => c.pipelineStage === filterStage)
    if (filterPriority) result = result.filter((c) => c.priority === filterPriority)
    if (filterRound) result = result.filter((c) => c.round === filterRound)
    if (filterQuery.trim()) {
      const q = filterQuery.trim().toLowerCase()
      result = result.filter((c) =>
        c.canonicalName.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
      )
    }
    return result
  }, [companies, filterStage, filterPriority, filterRound, filterQuery])

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
                        <span className={`${styles.priorityBadge} ${priorityClass(company.priority)}`}>
                          {formatPriority(company.priority)}
                        </span>
                      )}
                      {company.round && (
                        <span className={styles.roundBadge}>{formatRound(company.round)}</span>
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

      <div className={styles.filterBar}>
            <select
              className={styles.filterSelect}
              value={filterStage}
              onChange={(e) => setFilterStage(e.target.value as CompanyPipelineStage | '')}
            >
              <option value="">All Stages</option>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <select
              className={styles.filterSelect}
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value as CompanyPriority | '')}
            >
              <option value="">All Priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <select
              className={styles.filterSelect}
              value={filterRound}
              onChange={(e) => setFilterRound(e.target.value as CompanyRound | '')}
            >
              <option value="">All Rounds</option>
              {ROUNDS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <input
              className={styles.filterInput}
              placeholder="Search companies..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
          </div>

          <div className={styles.tableWrapper}>
            <table className={styles.pipelineTable}>
              <thead>
                <tr>
                  <th className={styles.companyColumn}>Company</th>
                  <th>Priority</th>
                  <th>Stage</th>
                  <th>Round</th>
                  <th>Post Money</th>
                  <th>Raise Size</th>
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
                    </td>
                    <td>
                      <select
                        className={styles.cellSelect}
                        value={company.priority || ''}
                        onChange={(e) => void updateCompanyField(company.id, 'priority', e.target.value || null)}
                      >
                        <option value="">-</option>
                        {PRIORITIES.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className={styles.cellSelect}
                        value={company.pipelineStage || ''}
                        onChange={(e) => void updateCompanyField(company.id, 'pipelineStage', e.target.value || null)}
                      >
                        <option value="">-</option>
                        {STAGES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className={styles.cellSelect}
                        value={company.round || ''}
                        onChange={(e) => void updateCompanyField(company.id, 'round', e.target.value || null)}
                      >
                        <option value="">-</option>
                        {ROUNDS.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
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
                      {(company.description || '').slice(0, 100) || '-'}
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
    </div>
  )
}
