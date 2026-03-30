import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote, CompanyTimelineItem } from '../../../shared/types/company'
import { useEmailSync } from '../../hooks/useEmailSync'
import { EmailDetailModal } from '../crm/EmailDetailModal'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import styles from './CompanyTimeline.module.css'

interface CompanyTimelineProps {
  companyId: string
  className?: string
  refreshKey?: number
}

const TYPE_LABEL: Record<string, string> = {
  meeting: 'Meeting',
  email: 'Email',
  note: 'Note',
  decision: 'Decision',
  'Stage Change': 'Stage Change',
  'Pipeline Exit': 'Pipeline Exit'
}

type TimelineFilter = 'all' | 'meeting' | 'email' | 'note' | 'decision'

const FILTERS: Array<{ key: TimelineFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'email', label: 'Emails' },
  { key: 'note', label: 'Notes' },
  { key: 'decision', label: 'Decisions' }
]

export function CompanyTimeline({ companyId, className, refreshKey }: CompanyTimelineProps) {
  const navigate = useNavigate()
  const [items, setItems] = useState<CompanyTimelineItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedItem, setSelectedItem] = useState<CompanyTimelineItem | null>(null)
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedThreadGroups, setSelectedThreadGroups] = useState<Set<string>>(new Set())

  const {
    isSyncing,
    syncError,
    syncResult,
    lastSyncedLabel,
    progressMsg,
    handleSync,
    handleCancel
  } = useEmailSync('company', companyId, () => setLoaded(false))

  // Reset loaded when refreshKey changes (e.g. after a pipeline stage change creates a new decision log)
  useEffect(() => {
    setLoaded(false)
  }, [companyId, refreshKey])

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<CompanyTimelineItem[]>(IPC_CHANNELS.COMPANY_TIMELINE, companyId)
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  function handleClick(item: CompanyTimelineItem) {
    if (selectMode && item.type === 'email' && item.threadGroup) {
      const tg = item.threadGroup
      setSelectedThreadGroups((prev) => {
        const next = new Set(prev)
        next.has(tg) ? next.delete(tg) : next.add(tg)
        return next
      })
      return
    }
    if (item.type === 'meeting') {
      navigate(`/meeting/${item.referenceId}`)
    } else {
      setSelectedItem(item)
    }
  }

  function handleToggleSelectMode() {
    if (selectMode) {
      setSelectedThreadGroups(new Set())
    }
    setSelectMode((prev) => !prev)
  }

  async function handleBulkDelete() {
    const threadGroups = [...selectedThreadGroups]
    if (threadGroups.length === 0) return
    try {
      await window.api.invoke(IPC_CHANNELS.COMPANY_EMAIL_UNLINK, companyId, threadGroups)
      setItems((prev) => prev.filter((i) => !i.threadGroup || !selectedThreadGroups.has(i.threadGroup)))
      setSelectedThreadGroups(new Set())
      setSelectMode(false)
    } catch (err) {
      console.error('[CompanyTimeline] bulk delete failed', err)
    }
  }

  const handleDecisionSaved = useCallback((_log: { id: string; decisionType: string; decisionOwner: string | null }) => {
    setItems((prev) =>
      prev.map((i) =>
        i.referenceId === _log.id
          ? { ...i, title: _log.decisionType, subtitle: _log.decisionOwner ?? null }
          : i
      )
    )
    setSelectedItem(null)
  }, [])

  const handleDecisionDeleted = useCallback((deletedId: string) => {
    setItems((prev) => prev.filter((i) => i.referenceId !== deletedId))
    setSelectedItem(null)
  }, [])

  const handleNoteUpdated = useCallback((note: CompanyNote) => {
    setItems((prev) =>
      prev.map((i) =>
        i.referenceId === note.id
          ? { ...i, subtitle: note.content.slice(0, 220) }
          : i
      )
    )
  }, [])

  const handleNoteDeleted = useCallback((deletedId: string) => {
    setItems((prev) => prev.filter((i) => i.referenceId !== deletedId))
    setSelectedItem(null)
  }, [])

  function getSyncResultMsg() {
    if (!syncResult) return null
    if (syncResult.aborted) {
      return syncResult.insertedMessageCount > 0
        ? `Cancelled — +${syncResult.insertedMessageCount} saved`
        : 'Cancelled'
    }
    return syncResult.insertedMessageCount > 0
      ? `+${syncResult.insertedMessageCount} new`
      : 'Up to date'
  }

  const syncResultMsg = getSyncResultMsg()
  const visibleItems = filter === 'all' ? items : items.filter((i) => i.type === filter)
  const hasEmails = loaded && items.some((i) => i.type === 'email')

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {loaded && items.length > 0 && (
        <div className={styles.filterRow}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${styles.filterPill} ${filter === f.key ? styles.filterActive : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      {(loaded || isSyncing) && (
        <div className={styles.syncRow}>
          <span className={styles.lastSynced}>{lastSyncedLabel}</span>
          {progressMsg && isSyncing && (
            <span className={styles.progressMsg}>{progressMsg}</span>
          )}
          <button
            className={styles.syncBtn}
            onClick={handleSync}
            disabled={isSyncing}
            title="Pull emails from Gmail for this company"
          >
            <span className={isSyncing ? styles.spinning : ''}>↻</span>
            {' '}{isSyncing ? 'Syncing…' : 'Sync emails'}
          </button>
          {isSyncing && (
            <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
          )}
          {hasEmails && !isSyncing && (
            <button className={styles.selectBtn} onClick={handleToggleSelectMode}>
              {selectMode ? 'Cancel' : 'Select'}
            </button>
          )}
          {syncResultMsg && !isSyncing && (
            <span className={styles.syncMsg}>{syncResultMsg}</span>
          )}
          {syncError && <span className={styles.syncError}>{syncError}</span>}
        </div>
      )}
      {selectMode && selectedThreadGroups.size > 0 && (
        <div className={styles.bulkActionRow}>
          <button className={styles.bulkDeleteBtn} onClick={handleBulkDelete}>
            Delete {selectedThreadGroups.size} email{selectedThreadGroups.size !== 1 ? 's' : ''}
          </button>
        </div>
      )}
      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && items.length === 0 && (
        <div className={styles.empty}>No timeline activity yet.</div>
      )}
      {loaded && items.length > 0 && visibleItems.length === 0 && (
        <div className={styles.empty}>No {filter}s found.</div>
      )}
      {visibleItems.map((item) => {
        const isSelected = item.type === 'email' && !!item.threadGroup && selectedThreadGroups.has(item.threadGroup)
        return (
          <div
            key={item.id}
            className={`${styles.item} ${styles[item.type]} ${styles.clickable} ${isSelected ? styles.emailSelected : ''}`}
            onClick={() => handleClick(item)}
            aria-checked={selectMode && item.type === 'email' ? isSelected : undefined}
          >
            {selectMode && item.type === 'email' && (
              <div className={styles.checkbox}>{isSelected ? '✓' : ''}</div>
            )}
            <div className={styles.dot} />
            <div className={styles.content}>
              <div className={styles.itemHeader}>
                <span className={styles.typeLabel}>{TYPE_LABEL[item.type] ?? item.type}</span>
                <span className={styles.date}>
                  {new Date(item.occurredAt).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', year: 'numeric'
                  })}
                </span>
              </div>
              <div className={styles.title}>{item.title}</div>
              {item.subtitle && <div className={styles.subtitle}><ReactMarkdown>{item.subtitle}</ReactMarkdown></div>}
            </div>
          </div>
        )
      })}

      {selectedItem?.type === 'email' && (
        <EmailDetailModal
          messageId={selectedItem.referenceId}
          onClose={() => setSelectedItem(null)}
        />
      )}
      {selectedItem?.type === 'note' && (
        <NoteDetailModal
          noteId={selectedItem.referenceId}
          onClose={() => setSelectedItem(null)}
          onUpdated={handleNoteUpdated}
          onDeleted={handleNoteDeleted}
        />
      )}
      {selectedItem?.type === 'decision' && (
        <DecisionLogModal
          companyId={companyId}
          logId={selectedItem.referenceId}
          onClose={() => setSelectedItem(null)}
          onSaved={handleDecisionSaved}
          onDeleted={handleDecisionDeleted}
        />
      )}
    </div>
  )
}
