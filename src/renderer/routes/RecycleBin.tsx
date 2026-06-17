import { useCallback, useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'
import EmptyState from '../components/common/EmptyState'
import type { DeletedEntitySummary } from '../../shared/types/recycle'
import { RECYCLE_RETENTION_DAYS } from '../../shared/types/recycle'

// Recycle Bin (Phase 3 multiplayer soft-delete). Lists the firm's trashed
// companies + tasks (already in local SQLite via pull) and lets any member
// Restore within the retention window. Admin "Delete permanently" lands in C2.

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

  const purge = useCallback(
    async (item: DeletedEntitySummary) => {
      if (!window.confirm(`Permanently delete "${item.label}"? This cannot be undone.`)) return
      setBusyId(item.id)
      try {
        await api.invoke(
          item.entityType === 'company' ? IPC_CHANNELS.COMPANY_PURGE : IPC_CHANNELS.TASK_PURGE,
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

  const renderSection = (title: string, items: DeletedEntitySummary[]) => (
    <section style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6, marginBottom: 8 }}>
        {title} ({items.length})
      </h3>
      {items.length === 0 ? (
        <p style={{ opacity: 0.5, fontSize: 13 }}>Nothing here.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((item) => (
            <li
              key={`${item.entityType}:${item.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 12px',
                borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  {item.sublabel ? `${item.sublabel} · ` : ''}
                  deleted by {item.deletedByName ?? 'a teammate'} · purges in {daysUntil(item.purgesAt)}d
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => void restore(item)} disabled={busyId === item.id}>
                  {busyId === item.id ? '…' : 'Restore'}
                </button>
                {isAdmin && (
                  <button
                    onClick={() => void purge(item)}
                    disabled={busyId === item.id}
                    style={{ color: 'var(--danger, #c0392b)' }}
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

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>

  const empty = companies.length === 0 && tasks.length === 0

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h2 style={{ marginBottom: 4 }}>Recycle Bin</h2>
      <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 20 }}>
        Deleted companies and tasks are recoverable for {RECYCLE_RETENTION_DAYS} days.
      </p>
      {error && <div style={{ color: 'var(--danger, #c0392b)', marginBottom: 12 }}>{error}</div>}
      {empty ? (
        <EmptyState title="Recycle Bin is empty" description="Deleted companies and tasks will appear here." />
      ) : (
        <>
          {renderSection('Companies', companies)}
          {renderSection('Tasks', tasks)}
        </>
      )}
    </div>
  )
}
