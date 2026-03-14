import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyEmailIngestResult, CompanyNote, CompanyTimelineItem } from '../../../shared/types/company'
import { EmailDetailModal } from '../crm/EmailDetailModal'
import { NoteDetailModal } from '../crm/NoteDetailModal'
import styles from './CompanyTimeline.module.css'

function getLastSyncedLabel(key: string): string {
  const raw = localStorage.getItem(key)
  if (!raw) return 'Never synced'
  const mins = Math.floor((Date.now() - new Date(raw).getTime()) / 60000)
  if (mins < 1) return 'Last synced just now'
  if (mins < 60) return `Last synced ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Last synced ${hours}h ago`
  return `Last synced ${Math.floor(hours / 24)}d ago`
}

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

  const isMountedRef = useRef(true)
  useEffect(() => () => { isMountedRef.current = false }, [])

  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<CompanyEmailIngestResult | null>(null)
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string>(
    () => getLastSyncedLabel(`sync:company:${companyId}`)
  )

  useEffect(() => {
    if (loaded) return
    window.api
      .invoke<CompanyTimelineItem[]>(IPC_CHANNELS.COMPANY_TIMELINE, companyId)
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId, loaded])

  async function handleSync() {
    if (!isMountedRef.current) return
    setIsSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await window.api.invoke<CompanyEmailIngestResult>(
        IPC_CHANNELS.COMPANY_EMAIL_INGEST, companyId
      )
      if (!isMountedRef.current) return
      setSyncResult(result)
      setLoaded(false)
      const key = `sync:company:${companyId}`
      localStorage.setItem(key, new Date().toISOString())
      setLastSyncedLabel('Last synced just now')
    } catch (err) {
      if (!isMountedRef.current) return
      setSyncError(err instanceof Error ? err.message : 'Sync failed.')
    } finally {
      if (isMountedRef.current) setIsSyncing(false)
    }
  }

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

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {(loaded || isSyncing) && (
        <div className={styles.syncRow}>
          <span className={styles.lastSynced}>{lastSyncedLabel}</span>
          <button
            className={styles.syncBtn}
            onClick={handleSync}
            disabled={isSyncing}
            title="Pull emails from Gmail for this company"
          >
            <span className={isSyncing ? styles.spinning : ''}>↻</span>
            {' '}{isSyncing ? 'Syncing…' : 'Sync emails'}
          </button>
          {syncResult && !isSyncing && (
            <span className={styles.syncMsg}>
              {syncResult.insertedMessageCount > 0
                ? `+${syncResult.insertedMessageCount} new`
                : 'Up to date'}
            </span>
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
