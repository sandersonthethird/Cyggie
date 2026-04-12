import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import EmptyState from '../components/common/EmptyState'
import type {
  TaskListItem,
  TaskListFilter,
  TaskStatus,
  TaskCategory,
  TaskCreateData,
  TaskUpdateData
} from '../../shared/types/task'
import styles from './Tasks.module.css'
import { api } from '../api'

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  done: 'Done',
  dismissed: 'Dismissed'
}

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  action_item: 'Action Item',
  decision: 'Decision',
  follow_up: 'Follow-up'
}

type GroupBy = 'none' | 'meeting' | 'company' | 'status' | 'category'

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`
  if (diffDays <= 7) return `In ${diffDays}d`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function isOverdue(dateStr: string): boolean {
  return new Date(dateStr) < new Date(new Date().toDateString())
}

function daysSinceCreated(dateStr: string): number {
  const created = new Date(dateStr).getTime()
  if (Number.isNaN(created)) return 0
  return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)))
}

function groupTasks(tasks: TaskListItem[], groupBy: GroupBy): [string, TaskListItem[]][] {
  if (groupBy === 'none') return [['', tasks]]
  const groups = new Map<string, TaskListItem[]>()
  for (const task of tasks) {
    let key: string
    switch (groupBy) {
      case 'meeting':
        key = task.meetingTitle || 'No Meeting'
        break
      case 'company':
        key = task.companyName || 'No Company'
        break
      case 'status':
        key = STATUS_LABELS[task.status]
        break
      case 'category':
        key = CATEGORY_LABELS[task.category]
        break
      default:
        key = ''
    }
    const existing = groups.get(key)
    if (existing) existing.push(task)
    else groups.set(key, [task])
  }
  return Array.from(groups.entries())
}

export default function Tasks() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [activeStatuses, setActiveStatuses] = useState<TaskStatus[]>(['open', 'in_progress'])
  const [categoryFilter, setCategoryFilter] = useState<TaskCategory | ''>('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')

  // New task form
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskCategory, setNewTaskCategory] = useState<TaskCategory>('action_item')

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Detail panel
  const [detailTask, setDetailTask] = useState<TaskListItem | null>(null)
  const [showDetailedCreate, setShowDetailedCreate] = useState(false)

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const filter: TaskListFilter = { limit: 500 }
      if (activeStatuses.length > 0 && activeStatuses.length < 4) {
        filter.status = activeStatuses
      }
      if (categoryFilter) {
        filter.category = [categoryFilter]
      }
      const results = await api.invoke<TaskListItem[]>(IPC_CHANNELS.TASK_LIST, filter)
      setTasks(results)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [activeStatuses, categoryFilter])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const statusCounts = useMemo(() => {
    const counts: Record<TaskStatus, number> = { open: 0, in_progress: 0, done: 0, dismissed: 0 }
    for (const task of tasks) {
      counts[task.status]++
    }
    return counts
  }, [tasks])

  const toggleStatus = useCallback((status: TaskStatus) => {
    setActiveStatuses((prev) => {
      if (prev.includes(status)) {
        const next = prev.filter((s) => s !== status)
        return next.length === 0 ? [status] : next
      }
      return [...prev, status]
    })
  }, [])

  const handleCreateTask = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTaskTitle.trim()) return
    try {
      await api.invoke(IPC_CHANNELS.TASK_CREATE, {
        title: newTaskTitle.trim(),
        category: newTaskCategory,
        source: 'manual'
      })
      setNewTaskTitle('')
      await fetchTasks()
    } catch (err) {
      setError(String(err))
    }
  }, [newTaskTitle, newTaskCategory, fetchTasks])

  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(tasks.map((t) => t.id)))
  }, [tasks])

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleBulkStatus = useCallback(async (status: TaskStatus) => {
    if (selectedIds.size === 0) return
    try {
      await api.invoke(IPC_CHANNELS.TASK_BULK_UPDATE_STATUS, Array.from(selectedIds), status)
      setSelectedIds(new Set())
      await fetchTasks()
      if (detailTask && selectedIds.has(detailTask.id)) {
        setDetailTask((prev) => prev ? { ...prev, status } : null)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [selectedIds, fetchTasks, detailTask])

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    try {
      for (const id of selectedIds) {
        await api.invoke(IPC_CHANNELS.TASK_DELETE, id)
      }
      if (detailTask && selectedIds.has(detailTask.id)) {
        setDetailTask(null)
      }
      setSelectedIds(new Set())
      await fetchTasks()
    } catch (err) {
      setError(String(err))
    }
  }, [selectedIds, fetchTasks, detailTask])

  const handleOpenDetail = useCallback((task: TaskListItem) => {
    setShowDetailedCreate(false)
    setDetailTask(task)
  }, [])

  const handleDetailedCreate = useCallback(async (data: TaskCreateData) => {
    if (!data.title.trim()) return
    try {
      await api.invoke(IPC_CHANNELS.TASK_CREATE, {
        ...data,
        title: data.title.trim(),
        source: 'manual'
      })
      setShowDetailedCreate(false)
      await fetchTasks()
    } catch (err) {
      setError(String(err))
    }
  }, [fetchTasks])

  const handleDetailUpdate = useCallback(async (field: keyof TaskUpdateData, value: unknown) => {
    if (!detailTask) return
    try {
      const updated = await api.invoke<TaskListItem>(
        IPC_CHANNELS.TASK_UPDATE,
        detailTask.id,
        { [field]: value }
      )
      if (updated) {
        setDetailTask((prev) => prev ? { ...prev, ...updated } : null)
      }
      await fetchTasks()
    } catch (err) {
      setError(String(err))
    }
  }, [detailTask, fetchTasks])

  const handleDeleteTask = useCallback(async () => {
    if (!detailTask) return
    try {
      await api.invoke(IPC_CHANNELS.TASK_DELETE, detailTask.id)
      setDetailTask(null)
      await fetchTasks()
    } catch (err) {
      setError(String(err))
    }
  }, [detailTask, fetchTasks])

  const grouped = useMemo(() => groupTasks(tasks, groupBy), [tasks, groupBy])

  const showEmptyState = !loading && tasks.length === 0 && activeStatuses.length === 4 && !categoryFilter

  return (
    <div className={styles.container}>
      <div className={styles.scrollArea}>
        {/* Filter bar */}
        <div className={styles.filterBar}>
          <div className={styles.filterGroup}>
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
              <button
                key={status}
                className={`${styles.filterChip} ${activeStatuses.includes(status) ? styles.activeFilter : ''}`}
                onClick={() => toggleStatus(status)}
              >
                {STATUS_LABELS[status]}
                {statusCounts[status] > 0 && (
                  <span className={styles.filterCount}>{statusCounts[status]}</span>
                )}
              </button>
            ))}
          </div>
          <select
            className={styles.filterSelect}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as TaskCategory | '')}
          >
            <option value="">All Types</option>
            <option value="action_item">Action Items</option>
            <option value="decision">Decisions</option>
            <option value="follow_up">Follow-ups</option>
          </select>
          <select
            className={styles.filterSelect}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <option value="none">No Grouping</option>
            <option value="meeting">By Meeting</option>
            <option value="company">By Company</option>
            <option value="status">By Status</option>
            <option value="category">By Type</option>
          </select>
        </div>

        {/* New task form */}
        <form className={styles.newTaskForm} onSubmit={handleCreateTask}>
          <input
            className={styles.newTaskInput}
            placeholder="Add a task..."
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
          />
          <select
            className={styles.newTaskCategory}
            value={newTaskCategory}
            onChange={(e) => setNewTaskCategory(e.target.value as TaskCategory)}
          >
            <option value="action_item">Action Item</option>
            <option value="decision">Decision</option>
            <option value="follow_up">Follow-up</option>
          </select>
          <button type="submit" className={styles.addButton} disabled={!newTaskTitle.trim()}>
            Add
          </button>
          <button
            type="button"
            className={styles.detailedCreateBtn}
            title="Create with details"
            onClick={() => {
              setDetailTask(null)
              setShowDetailedCreate(true)
            }}
          >
            ＋
          </button>
        </form>

        {error && <div className={styles.error}>{error}</div>}

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{selectedIds.size} selected</span>
            <button className={styles.bulkSelectAll} onClick={selectedIds.size === tasks.length ? handleDeselectAll : handleSelectAll}>
              {selectedIds.size === tasks.length ? 'Deselect All' : 'Select All'}
            </button>
            <div className={styles.bulkActions}>
              <button className={styles.bulkAction} onClick={() => handleBulkStatus('done')}>Mark Done</button>
              <button className={styles.bulkAction} onClick={() => handleBulkStatus('open')}>Mark Open</button>
              <button className={styles.bulkAction} onClick={() => handleBulkStatus('in_progress')}>In Progress</button>
              <button className={styles.bulkAction} onClick={() => handleBulkStatus('dismissed')}>Dismiss</button>
              <button className={`${styles.bulkAction} ${styles.bulkDanger}`} onClick={handleBulkDelete}>Delete</button>
            </div>
            <button className={styles.bulkClear} onClick={handleDeselectAll}>&times;</button>
          </div>
        )}

        {showEmptyState ? (
          <EmptyState
            title="No tasks yet"
            description="Tasks are proposed after enhancing meeting notes, or you can add them manually above."
          />
        ) : (
          <div className={styles.taskList}>
            {grouped.map(([groupLabel, groupTasks]) => (
              <div key={groupLabel || '__all'}>
                {groupLabel && <div className={styles.groupHeader}>{groupLabel}</div>}
                {groupTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`${styles.taskRow} ${task.status === 'done' ? styles.taskRowDone : ''} ${selectedIds.has(task.id) ? styles.taskRowSelected : ''}`}
                    onClick={() => handleOpenDetail(task)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(task.id)}
                      className={styles.taskCheckbox}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => handleToggleSelect(task.id)}
                    />
                    <div className={styles.taskContent}>
                      <span className={styles.taskTitle}>{task.title}</span>
                      <div className={styles.taskMeta}>
                        <span className={`${styles.categoryBadge} ${styles[`category_${task.category}`]}`}>
                          {CATEGORY_LABELS[task.category]}
                        </span>
                        {task.meetingTitle && (
                          <button
                            className={styles.metaLink}
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/meeting/${task.meetingId}`)
                            }}
                          >
                            {task.meetingTitle}
                          </button>
                        )}
                        {task.companyName && (
                          <button
                            className={styles.metaLink}
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate(`/company/${task.companyId}`)
                            }}
                          >
                            {task.companyName}
                          </button>
                        )}
                        {task.assignee && <span className={styles.assignee}>{task.assignee}</span>}
                        {task.dueDate && (
                          <span className={isOverdue(task.dueDate) ? styles.overdue : styles.dueDate}>
                            {formatDueDate(task.dueDate)}
                          </span>
                        )}
                        {task.source === 'auto' && <span className={styles.autoBadge}>Auto</span>}
                        <span className={styles.ageBadge}>{daysSinceCreated(task.createdAt)}d</span>
                      </div>
                    </div>
                    {task.priority && (
                      <span className={`${styles.priorityDot} ${styles[`priority_${task.priority}`]}`} />
                    )}
                  </div>
                ))}
              </div>
            ))}
            {!loading && tasks.length === 0 && (
              <p className={styles.noResults}>No tasks match the current filters.</p>
            )}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {detailTask && (
        <>
          <div className={styles.detailOverlay} onClick={() => setDetailTask(null)} />
          <DetailPanel
            task={detailTask}
            onUpdate={handleDetailUpdate}
            onDelete={handleDeleteTask}
            onClose={() => setDetailTask(null)}
            onNavigateMeeting={(id) => navigate(`/meeting/${id}`)}
            onNavigateCompany={(id) => navigate(`/company/${id}`)}
          />
        </>
      )}
      {showDetailedCreate && !detailTask && (
        <>
          <div className={styles.detailOverlay} onClick={() => setShowDetailedCreate(false)} />
          <DetailPanel
            createMode
            onCreate={handleDetailedCreate}
            onClose={() => setShowDetailedCreate(false)}
          />
        </>
      )}

    </div>
  )
}

type DetailPanelEditProps = {
  createMode?: false
  task: TaskListItem
  onUpdate: (field: keyof TaskUpdateData, value: unknown) => void
  onDelete: () => void
  onClose: () => void
  onNavigateMeeting: (id: string) => void
  onNavigateCompany: (id: string) => void
  onCreate?: never
}

type DetailPanelCreateProps = {
  createMode: true
  onCreate: (data: TaskCreateData) => void
  onClose: () => void
  task?: never
  onUpdate?: never
  onDelete?: never
  onNavigateMeeting?: never
  onNavigateCompany?: never
}

function DetailPanel(props: DetailPanelEditProps | DetailPanelCreateProps) {
  const { onClose, createMode } = props

  // Create mode local state
  const [createTitle, setCreateTitle] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createCategory, setCreateCategory] = useState<TaskCategory>('action_item')
  const [createStatus, setCreateStatus] = useState<TaskStatus>('open')
  const [createPriority, setCreatePriority] = useState<string>('')
  const [createDueDate, setCreateDueDate] = useState('')
  const [createAssignee, setCreateAssignee] = useState('')

  // Edit mode local state
  const task = createMode ? null : props.task
  const [title, setTitle] = useState(task?.title || '')
  const [description, setDescription] = useState(task?.description || '')
  const descRef = useRef<HTMLTextAreaElement>(null)

  const autoResizeDesc = useCallback(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(60, el.scrollHeight)}px`
  }, [])

  // Sync local state when task changes (edit mode)
  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description || '')
    }
  }, [task?.id, task?.title, task?.description])

  // Auto-resize on mount and when description changes externally
  useEffect(() => {
    autoResizeDesc()
  }, [task?.id, task?.description, autoResizeDesc])

  if (createMode) {
    const handleSubmit = () => {
      if (!createTitle.trim()) return
      props.onCreate({
        title: createTitle.trim(),
        description: createDescription.trim() || null,
        category: createCategory,
        priority: createPriority ? (createPriority as TaskCreateData['priority']) : null,
        dueDate: createDueDate || null,
        assignee: createAssignee.trim() || null
      })
    }

    return (
      <div className={styles.detailPanel}>
        <div className={styles.detailHeader}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>New Task</span>
          <button className={styles.detailCloseBtn} onClick={onClose}>&times;</button>
        </div>

        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Title</label>
          <input
            className={styles.detailInput}
            value={createTitle}
            onChange={(e) => setCreateTitle(e.target.value)}
            placeholder="Task title..."
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
        </div>

        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Description</label>
          <textarea
            ref={descRef}
            className={styles.detailTextarea}
            value={createDescription}
            onChange={(e) => {
              setCreateDescription(e.target.value)
              autoResizeDesc()
            }}
            placeholder="Add a description..."
          />
        </div>

        <div className={styles.detailRow}>
          <div className={styles.detailField}>
            <label className={styles.detailLabel}>Status</label>
            <select
              className={styles.detailSelect}
              value={createStatus}
              onChange={(e) => setCreateStatus(e.target.value as TaskStatus)}
            >
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
            </select>
          </div>

          <div className={styles.detailField}>
            <label className={styles.detailLabel}>Type</label>
            <select
              className={styles.detailSelect}
              value={createCategory}
              onChange={(e) => setCreateCategory(e.target.value as TaskCategory)}
            >
              <option value="action_item">Action Item</option>
              <option value="decision">Decision</option>
              <option value="follow_up">Follow-up</option>
            </select>
          </div>
        </div>

        <div className={styles.detailRow}>
          <div className={styles.detailField}>
            <label className={styles.detailLabel}>Priority</label>
            <select
              className={styles.detailSelect}
              value={createPriority}
              onChange={(e) => setCreatePriority(e.target.value)}
            >
              <option value="">None</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className={styles.detailField}>
            <label className={styles.detailLabel}>Due Date</label>
            <input
              type="date"
              className={styles.detailInput}
              value={createDueDate}
              onChange={(e) => setCreateDueDate(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Assignee</label>
          <input
            className={styles.detailInput}
            value={createAssignee}
            onChange={(e) => setCreateAssignee(e.target.value)}
            placeholder="Assign to someone..."
          />
        </div>

        <div className={styles.detailCreateActions}>
          <button
            className={styles.addButton}
            disabled={!createTitle.trim()}
            onClick={handleSubmit}
          >
            Create Task
          </button>
          <button
            className={styles.detailCancelBtn}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Edit mode
  const { onUpdate, onDelete, onNavigateMeeting, onNavigateCompany } = props

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <span className={`${styles.categoryBadge} ${styles[`category_${task!.category}`]}`}>
          {CATEGORY_LABELS[task!.category]}
        </span>
        <button className={styles.detailCloseBtn} onClick={onClose}>&times;</button>
      </div>

      <div className={styles.detailField}>
        <label className={styles.detailLabel}>Title</label>
        <input
          className={styles.detailInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title !== task!.title) onUpdate('title', title.trim())
          }}
        />
      </div>

      <div className={styles.detailField}>
        <label className={styles.detailLabel}>Description</label>
        <textarea
          ref={descRef}
          className={styles.detailTextarea}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
            autoResizeDesc()
          }}
          onBlur={() => {
            const val = description.trim() || null
            if (val !== (task!.description || '')) onUpdate('description', val)
          }}
          placeholder="Add a description..."
        />
      </div>

      <div className={styles.detailRow}>
        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Status</label>
          <select
            className={styles.detailSelect}
            value={task!.status}
            onChange={(e) => onUpdate('status', e.target.value)}
          >
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </div>

        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Type</label>
          <select
            className={styles.detailSelect}
            value={task!.category}
            onChange={(e) => onUpdate('category', e.target.value)}
          >
            <option value="action_item">Action Item</option>
            <option value="decision">Decision</option>
            <option value="follow_up">Follow-up</option>
          </select>
        </div>
      </div>

      <div className={styles.detailRow}>
        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Priority</label>
          <select
            className={styles.detailSelect}
            value={task!.priority || ''}
            onChange={(e) => onUpdate('priority', e.target.value || null)}
          >
            <option value="">None</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div className={styles.detailField}>
          <label className={styles.detailLabel}>Due Date</label>
          <input
            type="date"
            className={styles.detailInput}
            value={task!.dueDate || ''}
            onChange={(e) => onUpdate('dueDate', e.target.value || null)}
          />
        </div>
      </div>

      <div className={styles.detailField}>
        <label className={styles.detailLabel}>Assignee</label>
        <input
          key={`assignee-${task!.id}-${task!.assignee}`}
          className={styles.detailInput}
          defaultValue={task!.assignee || ''}
          onBlur={(e) => {
            const val = e.target.value.trim() || null
            if (val !== task!.assignee) onUpdate('assignee', val)
          }}
          placeholder="Assign to someone..."
        />
      </div>

      {/* Source links */}
      {(task!.meetingTitle || task!.companyName) && (
        <div className={styles.detailMeta}>
          {task!.meetingTitle && task!.meetingId && (
            <p>
              Meeting:{' '}
              <button
                className={styles.detailSourceLink}
                onClick={() => onNavigateMeeting(task!.meetingId!)}
              >
                {task!.meetingTitle}
              </button>
            </p>
          )}
          {task!.companyName && task!.companyId && (
            <p>
              Company:{' '}
              <button
                className={styles.detailSourceLink}
                onClick={() => onNavigateCompany(task!.companyId!)}
              >
                {task!.companyName}
              </button>
            </p>
          )}
          {task!.source === 'auto' && (
            <p>Source: Auto-extracted from summary</p>
          )}
        </div>
      )}

      <div className={styles.detailMeta}>
        <p>Created: {new Date(task!.createdAt).toLocaleString()}</p>
        <p>Updated: {new Date(task!.updatedAt).toLocaleString()}</p>
      </div>

      <button className={styles.detailDeleteBtn} onClick={onDelete}>
        Delete Task
      </button>
    </div>
  )
}
