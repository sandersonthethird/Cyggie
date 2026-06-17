import { useCallback, useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'
import EmptyState from '../components/common/EmptyState'
import ConfirmDialog from '../components/common/ConfirmDialog'
import type { DeletedEntitySummary } from '../../shared/types/recycle'
import { RECYCLE_RETENTION_DAYS } from '../../shared/types/recycle'
import styles from './RecycleBin.module.css'

// Recycle Bin (Phase 3 multiplayer soft-delete). Lists the firm's trashed
// companies + tasks (already in local SQLite via pull) and lets any member
// Restore within the retention window. Admins can "Delete permanently" (purge).

function daysUntil(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return RECYCLE_RETENTION_DAYS
  return Math.max(0, Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000)))
}

export default function RecycleBin() {
  const [companies, setCompanies] = useState<DeletedEntitySummary[]>([])
  const [tasks, setTasks] = useState<DeletedEntitySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<DeletedEntitySummary | null>(null)
  const [purgeError, setPurgeError] = useState<string | null>(null)

  useEffect(() => {
    api
      .invoke<{ role?: string } | null>(IPC_CHANNELS.USER_GET_CURRENT)
      .then((u) => setIsAdmin(u?.role === 'admin'))
      .catch(() => setIsAdmin(false))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [c, t] = await Promise.all([
        api.invoke<DeletedEntitySummary[]>(IPC_CHANNELS.COMPANY_LIST_DELETED),
        api.invoke<DeletedEntitySummary[]>(IPC_CHANNELS.TASK_LIST_DELETED),
      ])
      setCompanies(c)
      setTasks(t)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const restore = useCallback(
    async (item: DeletedEntitySummary) => {
      setBusyId(item.id)
      try {
        await api.invoke(
          item.entityType === 'company'
            ? IPC_CHANNELS.COMPANY_RESTORE
            : IPC_CHANNELS.TASK_RESTORE,
          item.id,
        )
        await load()
      } catch (err) {
        setError(String(err))
      } finally {
        setBusyId(null)
      }
    },
    [load],
  )

  const confirmPurge = useCallback(async () => {
    if (!purgeTarget) return
    const item = purgeTarget
    setBusyId(item.id)
    setPurgeError(null)
    try {
      await api.invoke(
        item.entityType === 'company' ? IPC_CHANNELS.COMPANY_PURGE : IPC_CHANNELS.TASK_PURGE,
        item.id,
      )
      setPurgeTarget(null)
      await load()
    } catch (err) {
      setPurgeError(String(err))
    } finally {
      setBusyId(null)
    }
  }, [purgeTarget, load])

  const renderSection = (title: string, items: DeletedEntitySummary[]) => (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p className={styles.empty}>Nothing here.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={`${item.entityType}:${item.id}`} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowLabel}>{item.label}</div>
                <div className={styles.rowMeta}>
                  {item.sublabel ? `${item.sublabel} · ` : ''}
                  deleted by {item.deletedByName ?? 'a teammate'} · purges in {daysUntil(item.purgesAt)}d
                </div>
              </div>
              <div className={styles.actions}>
                <button onClick={() => void restore(item)} disabled={busyId === item.id}>
                  {busyId === item.id ? '…' : 'Restore'}
                </button>
                {isAdmin && (
                  <button
                    className={styles.purgeButton}
                    onClick={() => {
                      setPurgeError(null)
                      setPurgeTarget(item)
                    }}
                    disabled={busyId === item.id}
                  >
                    Delete permanently
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  if (loading) return <div className={styles.container}>Loading…</div>

  const empty = companies.length === 0 && tasks.length === 0

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Recycle Bin</h2>
      <p className={styles.subhead}>
        Deleted companies and tasks are recoverable for {RECYCLE_RETENTION_DAYS} days.
      </p>
      {error && <div className={styles.error}>{error}</div>}
      {empty ? (
        <EmptyState title="Recycle Bin is empty" description="Deleted companies and tasks will appear here." />
      ) : (
        <>
          {renderSection('Companies', companies)}
          {renderSection('Tasks', tasks)}
        </>
      )}
      <ConfirmDialog
        open={purgeTarget != null}
        title="Delete permanently?"
        message={
          purgeTarget
            ? `Permanently delete "${purgeTarget.label}"? This cannot be undone and removes it for the whole firm.`
            : ''
        }
        confirmLabel={busyId && purgeTarget && busyId === purgeTarget.id ? 'Deleting…' : 'Delete permanently'}
        variant="danger"
        errorMessage={purgeError}
        onConfirm={() => void confirmPurge()}
        onCancel={() => setPurgeTarget(null)}
      />
    </div>
  )
}
