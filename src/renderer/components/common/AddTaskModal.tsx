import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import styles from './AddTaskModal.module.css'

interface AddTaskModalProps {
  entityId: string
  entityName: string
  entityType: 'company' | 'contact'
  onClose: () => void
}

export function AddTaskModal({ entityId, entityName, entityType, onClose }: AddTaskModalProps) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<'action_item' | 'follow_up' | 'decision'>('follow_up')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await api.invoke(IPC_CHANNELS.TASK_CREATE, {
        title: title.trim(),
        category,
        ...(entityType === 'company' ? { companyId: entityId } : { contactId: entityId }),
        source: 'manual',
      })
      onClose()
    } catch {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles.modal}>
        <div className={styles.title}>New Task</div>
        <div className={styles.entity}>{entityName}</div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.field}>
            <label className={styles.label}>Task</label>
            <input
              autoFocus
              className={styles.input}
              placeholder="e.g. Send term sheet"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Category</label>
            <select
              className={styles.input}
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
              disabled={submitting}
            >
              <option value="follow_up">Follow-up</option>
              <option value="action_item">Action Item</option>
              <option value="decision">Decision</option>
            </select>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className={styles.submitBtn} disabled={submitting || !title.trim()}>
              {submitting ? 'Adding…' : 'Add Task'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
