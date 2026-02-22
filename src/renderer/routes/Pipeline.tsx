import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CompanySummary } from '../../shared/types/company'
import type { PipelineBoard } from '../../shared/types/pipeline'
import styles from './Pipeline.module.css'

function formatLastTouch(value: string | null): string {
  if (!value) return 'No touchpoint'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No touchpoint'
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'Touched today'
  if (days === 1) return 'Touched yesterday'
  return `Touched ${days}d ago`
}

export default function Pipeline() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [board, setBoard] = useState<PipelineBoard | null>(null)
  const [companies, setCompanies] = useState<CompanySummary[]>([])
  const [newCompanyId, setNewCompanyId] = useState('')
  const [newStageId, setNewStageId] = useState('')
  const [dragDealId, setDragDealId] = useState<string | null>(null)

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    [companies]
  )

  const loadBoard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [boardData, companyData] = await Promise.all([
        window.api.invoke<PipelineBoard>(IPC_CHANNELS.PIPELINE_GET_BOARD),
        window.api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, {
          view: 'all',
          limit: 1000
        })
      ])
      setBoard(boardData)
      setCompanies(companyData)
      if (!newStageId && boardData.stages.length > 0) {
        setNewStageId(boardData.stages[0].id)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [newStageId])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  const handleCreateDeal = useCallback(async () => {
    if (!newCompanyId) return
    try {
      await window.api.invoke(IPC_CHANNELS.PIPELINE_CREATE_DEAL, {
        companyId: newCompanyId,
        stageId: newStageId || null
      })
      setNewCompanyId('')
      await loadBoard()
    } catch (err) {
      setError(String(err))
    }
  }, [loadBoard, newCompanyId, newStageId])

  const moveDeal = useCallback(async (dealId: string, stageId: string) => {
    try {
      await window.api.invoke(IPC_CHANNELS.PIPELINE_MOVE_DEAL, dealId, stageId, null)
      await loadBoard()
    } catch (err) {
      setError(String(err))
    }
  }, [loadBoard])

  if (loading && !board) {
    return <div className={styles.page}>Loading pipeline...</div>
  }

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Pipeline</h1>
        <button className={styles.linkButton} onClick={() => navigate('/settings')}>
          Configure stages
        </button>
      </div>

      <div className={styles.createRow}>
        <select
          className={styles.select}
          value={newCompanyId}
          onChange={(event) => setNewCompanyId(event.target.value)}
        >
          <option value="">Select company...</option>
          {sortedCompanies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.canonicalName}
            </option>
          ))}
        </select>
        <select
          className={styles.select}
          value={newStageId}
          onChange={(event) => setNewStageId(event.target.value)}
        >
          {(board?.stages || []).map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.label}
            </option>
          ))}
        </select>
        <button className={styles.primaryButton} onClick={() => void handleCreateDeal()}>
          Create deal
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.board}>
        {(board?.stages || []).map((stage) => (
          <div
            key={stage.id}
            className={styles.column}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!dragDealId) return
              void moveDeal(dragDealId, stage.id)
              setDragDealId(null)
            }}
          >
            <div className={styles.columnHeader}>
              <span className={styles.columnTitle}>{stage.label}</span>
              <span className={styles.countBadge}>
                {board?.columns.find((column) => column.stage.id === stage.id)?.deals.length || 0}
              </span>
            </div>

            <div className={styles.columnBody}>
              {(board?.columns.find((column) => column.stage.id === stage.id)?.deals || []).map((deal) => (
                <div
                  key={deal.id}
                  className={styles.dealCard}
                  draggable
                  onDragStart={() => setDragDealId(deal.id)}
                  onDoubleClick={() => navigate(`/company/${deal.companyId}`)}
                >
                  <button
                    className={styles.dealNameButton}
                    onClick={() => navigate(`/company/${deal.companyId}`)}
                  >
                    {deal.companyName}
                  </button>
                  <div className={styles.dealMeta}>
                    {deal.contactName || deal.contactEmail || 'No primary contact'}
                  </div>
                  <div className={styles.dealMeta}>
                    Stage age: {deal.stageDurationDays}d
                  </div>
                  <div className={styles.dealMeta}>
                    {formatLastTouch(deal.lastTouchpoint)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
