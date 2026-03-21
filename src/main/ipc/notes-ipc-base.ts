/**
 * Shared IPC handler registration for entity-scoped note operations.
 *
 * Both contact notes and company notes expose the same five handlers
 * (LIST / GET / CREATE / UPDATE / DELETE). This factory eliminates the
 * duplicated boilerplate so each IPC file is ~15 lines.
 *
 * Usage:
 *   registerEntityNotesIpc({
 *     channels: { list, get, create, update, delete },
 *     entityIdParam: 'contactId',
 *     auditType: 'contact_note',
 *     repo: contactNotesRepo,
 *   })
 *
 * The optional `onBeforeList` hook is called before the list query returns —
 * used by company notes to backfill meeting summary notes on first open.
 */

import { ipcMain } from 'electron'
import { getCurrentUserId } from '../security/current-user'
import { logAudit } from '../database/repositories/audit.repo'
import { hydrateCompanionNote } from './note-hydration'
import type { EntityNotesRepo } from '../database/repositories/notes-base'

export interface EntityNotesIpcConfig {
  channels: {
    list: string
    get: string
    create: string
    update: string
    delete: string
  }
  /** The key used for the entity ID in the CREATE payload (e.g. 'contactId' or 'companyId'). */
  entityIdParam: string
  /** Audit type string logged on create/update/delete (e.g. 'contact_note'). */
  auditType: string
  repo: EntityNotesRepo
  /** Optional hook called before the list query (receives entityId and userId). */
  onBeforeList?: (entityId: string, userId: string | null) => void
}

export function registerEntityNotesIpc(config: EntityNotesIpcConfig): void {
  const { channels, entityIdParam, auditType, repo, onBeforeList } = config

  ipcMain.handle(channels.list, (_event, entityId: string) => {
    if (!entityId) throw new Error(`${entityIdParam} is required`)
    const userId = getCurrentUserId()
    onBeforeList?.(entityId, userId)
    return repo.list(entityId)
  })

  ipcMain.handle(channels.get, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const note = repo.get(noteId)
    if (!note) return null
    return hydrateCompanionNote(note, getCurrentUserId())
  })

  ipcMain.handle(
    channels.create,
    (_event, data: Record<string, unknown>) => {
      const entityId = data?.[entityIdParam] as string | undefined
      if (!entityId) throw new Error(`${entityIdParam} is required`)
      if (!(data.content as string)?.trim()) throw new Error('content is required')
      const userId = getCurrentUserId()
      const note = repo.create(
        {
          entityId,
          title: (data.title as string | null | undefined) ?? null,
          content: data.content as string,
          themeId: (data.themeId as string | null | undefined) ?? null,
        },
        userId
      )
      if (!note) throw new Error('Failed to create note')
      logAudit(userId, auditType, note.id, 'create', data)
      return note
    }
  )

  ipcMain.handle(
    channels.update,
    (
      _event,
      noteId: string,
      updates: Partial<{ title: string | null; content: string; isPinned: boolean; themeId: string | null }>
    ) => {
      if (!noteId) throw new Error('noteId is required')
      const userId = getCurrentUserId()
      const note = repo.update(noteId, updates || {}, userId)
      if (note) logAudit(userId, auditType, noteId, 'update', updates || {})
      return note
    }
  )

  ipcMain.handle(channels.delete, (_event, noteId: string) => {
    if (!noteId) throw new Error('noteId is required')
    const userId = getCurrentUserId()
    const deleted = repo.delete(noteId)
    if (deleted) logAudit(userId, auditType, noteId, 'delete', null)
    return deleted
  })
}
