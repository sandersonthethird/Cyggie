import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { TaskRow } from '../schema'
import type {
  Task,
  TaskListItem,
  TaskListFilter,
  TaskCreateData,
  TaskUpdateData,
  TaskStatus,
  TaskSummaryStats
} from '../../../shared/types/task'

interface TaskListRow extends TaskRow {
  meeting_title: string | null
  meeting_date: string | null
  company_name: string | null
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    meetingId: row.meeting_id,
    companyId: row.company_id,
    contactId: row.contact_id,
    status: row.status as Task['status'],
    category: row.category as Task['category'],
    priority: row.priority as Task['priority'],
    assignee: row.assignee,
    dueDate: row.due_date,
    source: row.source as Task['source'],
    sourceSection: row.source_section,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToTaskListItem(row: TaskListRow): TaskListItem {
  return {
    ...rowToTask(row),
    meetingTitle: row.meeting_title,
    meetingDate: row.meeting_date,
    companyName: row.company_name
  }
}

const LIST_SELECT = `
  SELECT
    t.*,
    m.title AS meeting_title,
    m.date AS meeting_date,
    c.canonical_name AS company_name
  FROM tasks t
  LEFT JOIN meetings m ON m.id = t.meeting_id
  LEFT JOIN org_companies c ON c.id = t.company_id
`

export function listTasks(filter?: TaskListFilter): TaskListItem[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter?.status && filter.status.length > 0) {
    conditions.push(`t.status IN (${filter.status.map(() => '?').join(', ')})`)
    params.push(...filter.status)
  }

  if (filter?.category && filter.category.length > 0) {
    conditions.push(`t.category IN (${filter.category.map(() => '?').join(', ')})`)
    params.push(...filter.category)
  }

  if (filter?.priority && filter.priority.length > 0) {
    conditions.push(`t.priority IN (${filter.priority.map(() => '?').join(', ')})`)
    params.push(...filter.priority)
  }

  if (filter?.meetingId) {
    conditions.push('t.meeting_id = ?')
    params.push(filter.meetingId)
  }

  if (filter?.companyId) {
    conditions.push('t.company_id = ?')
    params.push(filter.companyId)
  }

  if (filter?.assignee) {
    conditions.push('t.assignee = ?')
    params.push(filter.assignee)
  }

  if (filter?.hasDueDate === true) {
    conditions.push('t.due_date IS NOT NULL')
  } else if (filter?.hasDueDate === false) {
    conditions.push('t.due_date IS NULL')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const orderBy = `
    ORDER BY
      CASE t.status
        WHEN 'in_progress' THEN 0
        WHEN 'open' THEN 1
        WHEN 'done' THEN 2
        WHEN 'dismissed' THEN 3
      END,
      CASE t.priority
        WHEN 'high' THEN 0
        WHEN 'medium' THEN 1
        WHEN 'low' THEN 2
        ELSE 3
      END,
      datetime(t.created_at) DESC
  `

  const limit = filter?.limit ? `LIMIT ${filter.limit}` : 'LIMIT 500'
  const offset = filter?.offset ? `OFFSET ${filter.offset}` : ''

  const rows = db
    .prepare(`${LIST_SELECT} ${where} ${orderBy} ${limit} ${offset}`)
    .all(...params) as TaskListRow[]

  return rows.map(rowToTaskListItem)
}

export function getTask(taskId: string): Task | null {
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(taskId) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export function createTask(data: TaskCreateData, userId: string | null = null): Task {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, meeting_id, company_id, contact_id,
      status, category, priority, assignee, due_date,
      source, source_section, extraction_hash,
      created_by_user_id, updated_by_user_id,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.title,
    data.description ?? null,
    data.meetingId ?? null,
    data.companyId ?? null,
    data.contactId ?? null,
    data.category ?? 'action_item',
    data.priority ?? null,
    data.assignee ?? null,
    data.dueDate ?? null,
    data.source ?? 'manual',
    data.sourceSection ?? null,
    data.extractionHash ?? null,
    userId,
    userId
  )
  return getTask(id)!
}

export function updateTask(
  taskId: string,
  data: TaskUpdateData,
  userId: string | null = null
): Task | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title)
  }
  if (data.description !== undefined) {
    sets.push('description = ?')
    params.push(data.description)
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    params.push(data.status)
  }
  if (data.category !== undefined) {
    sets.push('category = ?')
    params.push(data.category)
  }
  if (data.priority !== undefined) {
    sets.push('priority = ?')
    params.push(data.priority)
  }
  if (data.assignee !== undefined) {
    sets.push('assignee = ?')
    params.push(data.assignee)
  }
  if (data.dueDate !== undefined) {
    sets.push('due_date = ?')
    params.push(data.dueDate)
  }
  if (data.companyId !== undefined) {
    sets.push('company_id = ?')
    params.push(data.companyId)
  }
  if (data.contactId !== undefined) {
    sets.push('contact_id = ?')
    params.push(data.contactId)
  }

  if (sets.length === 0) return getTask(taskId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(taskId)

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getTask(taskId)
}

export function deleteTask(taskId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  return result.changes > 0
}

export function existsByMeetingAndHash(meetingId: string, hash: string): boolean {
  const db = getDatabase()
  const row = db
    .prepare('SELECT 1 FROM tasks WHERE meeting_id = ? AND extraction_hash = ?')
    .get(meetingId, hash)
  return !!row
}

export function listTasksForMeeting(meetingId: string): Task[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT * FROM tasks WHERE meeting_id = ?
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 WHEN 'dismissed' THEN 3 END,
        datetime(created_at) DESC
    `)
    .all(meetingId) as TaskRow[]
  return rows.map(rowToTask)
}

export function listTasksForCompany(companyId: string): Task[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT * FROM tasks WHERE company_id = ?
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 WHEN 'dismissed' THEN 3 END,
        datetime(created_at) DESC
    `)
    .all(companyId) as TaskRow[]
  return rows.map(rowToTask)
}

export function getTaskSummaryStats(): TaskSummaryStats {
  const db = getDatabase()
  const now = new Date()
  const endOfWeek = new Date(now)
  endOfWeek.setDate(now.getDate() + (7 - now.getDay()))
  endOfWeek.setHours(23, 59, 59, 999)
  const todayStr = now.toISOString().split('T')[0]
  const endOfWeekStr = endOfWeek.toISOString().split('T')[0]

  const row = db
    .prepare(`
      SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date <= ? THEN 1 ELSE 0 END) AS due_this_week,
        SUM(CASE WHEN status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) AS overdue_count
      FROM tasks
    `)
    .get(endOfWeekStr, todayStr) as {
      open_count: number
      in_progress_count: number
      due_this_week: number
      overdue_count: number
    }

  return {
    openCount: row.open_count || 0,
    inProgressCount: row.in_progress_count || 0,
    dueThisWeek: row.due_this_week || 0,
    overdueCount: row.overdue_count || 0
  }
}

export function bulkCreate(tasks: TaskCreateData[], userId: string | null = null): Task[] {
  const db = getDatabase()
  const tx = db.transaction(() => {
    return tasks.map((data) => createTask(data, userId))
  })
  return tx()
}

export function bulkUpdateStatus(
  taskIds: string[],
  status: TaskStatus,
  userId: string | null = null
): number {
  const db = getDatabase()
  const placeholders = taskIds.map(() => '?').join(', ')
  const params: unknown[] = [status]
  if (userId) params.push(userId)
  params.push(...taskIds)

  const result = db
    .prepare(`
      UPDATE tasks
      SET status = ?, ${userId ? 'updated_by_user_id = ?,' : ''} updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `)
    .run(...params)

  return result.changes
}
