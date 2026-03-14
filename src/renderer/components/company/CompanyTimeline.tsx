import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyNote, CompanyTimelineItem } from '../../../shared/types/company'
import { useEmailSync } from '../../hooks/useEmailSync'
import { EmailDetailModal } from '../crm/EmailDetailModal'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import styles from './CompanyTimeline.module.css'

interface CompanyTimelineProps {
  companyId: string
  className?: string
}

const TYPE_LABEL: Record<string, string> = {
  meeting: 'Meeting',
  email: 'Email',
  note: 'Note'
}

export function CompanyTimeline({ companyId, className }: CompanyTimelineProps) {
  const navigate = useNavigate()
  const [items, setItems] = useState<CompanyTimelineItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedItem, setSelectedItem] = useState<CompanyTimelineItem | null>(null)

  const {
    isSyncing,
    syncError,
    syncResult,
    lastSyncedLabel,
    progressMsg,
    handleSync,
    handleCancel
  } = useEmailSync('company', companyId, () => setLoaded(false))

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<CompanyTimelineItem[]>(IPC_CHANNELS.COMPANY_TIMELINE, companyId)
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  function handleClick(item: CompanyTimelineItem) {
    if (item.type === 'meeting') {
      navigate(`/meeting/${item.referenceId}`)
    } else {
      setSelectedItem(item)
    }
  }

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

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
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
          {syncResultMsg && !isSyncing && (
            <span className={styles.syncMsg}>{syncResultMsg}</span>
          )}
          {syncError && <span className={styles.syncError}>{syncError}</span>}
        </div>
      )}
      {!loaded && <div className={styles.loading}>Loading…</div>}
      {loaded && items.length === 0 && (
        <div className={styles.empty}>No timeline activity yet.</div>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className={`${styles.item} ${styles[item.type]} ${styles.clickable}`}
          onClick={() => handleClick(item)}
        >
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
            {item.subtitle && <div className={styles.subtitle}>{item.subtitle}</div>}
          </div>
        </div>
      ))}

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
    </div>
  )
}
