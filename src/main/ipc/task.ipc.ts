import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as taskRepo from '../database/repositories/task.repo'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import type { TaskListFilter, TaskCreateData, TaskUpdateData, TaskStatus } from '../../shared/types/task'

export function registerTaskHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.TASK_LIST, (_event, filter?: TaskListFilter) => {
    return taskRepo.listTasks(filter)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_GET, (_event, taskId: string) => {
    if (!taskId) throw new Error('taskId is required')
    return taskRepo.getTask(taskId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_CREATE, (_event, data: TaskCreateData) => {
    if (!data?.title?.trim()) throw new Error('title is required')
    const userId = getCurrentUserId()
    const task = taskRepo.createTask(data, userId)
    logAudit(userId, 'task', task.id, 'create', data)
    return task
  })

  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE,
    (_event, taskId: string, updates: TaskUpdateData) => {
      if (!taskId) throw new Error('taskId is required')
      const userId = getCurrentUserId()
      const task = taskRepo.updateTask(taskId, updates || {}, userId)
      if (task) {
        logAudit(userId, 'task', taskId, 'update', updates || {})
      }
      return task
    }
  )

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, (_event, taskId: string) => {
    if (!taskId) throw new Error('taskId is required')
    const userId = getCurrentUserId()
    const deleted = taskRepo.deleteTask(taskId)
    if (deleted) {
      logAudit(userId, 'task', taskId, 'delete', null)
    }
    return deleted
  })

  ipcMain.handle(IPC_CHANNELS.TASK_LIST_FOR_MEETING, (_event, meetingId: string) => {
    if (!meetingId) throw new Error('meetingId is required')
    return taskRepo.listTasksForMeeting(meetingId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_LIST_FOR_COMPANY, (_event, companyId: string) => {
    if (!companyId) throw new Error('companyId is required')
    return taskRepo.listTasksForCompany(companyId)
  })

  ipcMain.handle(IPC_CHANNELS.TASK_SUMMARY_STATS, () => {
    return taskRepo.getTaskSummaryStats()
  })

  ipcMain.handle(
    IPC_CHANNELS.TASK_BULK_CREATE,
    (_event, tasks: TaskCreateData[]) => {
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks array required')
      const userId = getCurrentUserId()
      const created = taskRepo.bulkCreate(tasks, userId)
      logAudit(userId, 'task', created.map((t) => t.id).join(','), 'bulk_create', { count: created.length })
      return created
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TASK_BULK_UPDATE_STATUS,
    (_event, taskIds: string[], status: TaskStatus) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0) throw new Error('taskIds required')
      const userId = getCurrentUserId()
      const count = taskRepo.bulkUpdateStatus(taskIds, status, userId)
      logAudit(userId, 'task', taskIds.join(','), 'bulk_update', { status })
      return count
    }
  )
}
