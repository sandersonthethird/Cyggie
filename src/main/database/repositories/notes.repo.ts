import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { Note, NoteFilterView, NoteCreateData, NoteUpdateData } from '../../../shared/types/note'

interface NoteRow {
  id: string
  title: string | null
  content: string
  company_id: string | null
  contact_id: string | null
  source_meeting_id: string | null
  theme_id: string | null
  is_pinned: number
  created_by_user_id: string | null
  updated_by_user_id: string | null
  created_at: string
  updated_at: string
  folder_path: string | null
  import_source: string | null
  company_name?: string | null
  contact_name?: string | null
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    companyId: row.company_id,
    contactId: row.contact_id,
    sourceMeetingId: row.source_meeting_id,
    themeId: row.theme_id,
    isPinned: row.is_pinned === 1,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    folderPath: row.folder_path ?? null,
    importSource: row.import_source ?? null,
    companyName: row.company_name ?? null,
    contactName: row.contact_name ?? null,
  }
}

const BASE_SELECT = `
  SELECT
    n.id,
    n.title,
    n.content,
    n.company_id,
    n.contact_id,
    n.source_meeting_id,
    n.theme_id,
    n.is_pinned,
    n.created_by_user_id,
    n.updated_by_user_id,
    n.created_at,
    n.updated_at,
    n.folder_path,
    n.import_source,
    c.canonical_name AS company_name,
    ct.full_name AS contact_name
  FROM notes n
  LEFT JOIN org_companies c ON c.id = n.company_id
  LEFT JOIN contacts ct ON ct.id = n.contact_id
`

/** Build folder filter clause and bindings (GLOB for index-safe prefix match). */
function folderFilter(folderPath: string | null | undefined): { clause: string; params: string[] } {
  if (!folderPath) return { clause: '', params: [] }
  return {
    clause: 'AND (n.folder_path = ? OR n.folder_path GLOB ?)',
    params: [folderPath, folderPath + '/*'],
  }
}

/**
 * Dedup filter: when multiple notes share a source_meeting_id (companion note +
 * company backfill notes), show only the earliest-created one in list views.
 * Notes without a source_meeting_id are unaffected.
 */
const DEDUP_FILTER = `
  AND (
    n.source_meeting_id IS NULL
    OR n.id = (
      SELECT id FROM notes
      WHERE source_meeting_id = n.source_meeting_id
      ORDER BY created_at ASC
      LIMIT 1
    )
  )
`

/**
 * Claimed meeting filter: hides meeting notes that are already tagged to a company
 * (they have a canonical home in the company detail Notes tab). Meeting notes with
 * no company tag (thematic/admin calls) remain visible in the Notes section.
 *
 * Rule: exclude notes where source_meeting_id IS NOT NULL AND company_id IS NOT NULL
 * Equivalent: keep notes where source_meeting_id IS NULL OR company_id IS NULL
 */
const CLAIMED_MEETING_FILTER = `
  AND (n.source_meeting_id IS NULL OR n.company_id IS NULL)
`

export function listNotes(
  filter: NoteFilterView = 'all',
  folderPath?: string | null,
  hideClaimedMeetingNotes?: boolean
): Note[] {
  const db = getDatabase()
  const { clause: folderClause, params: folderParams } = folderFilter(folderPath)

  let whereClause = ''
  if (filter === 'untagged') {
    whereClause = 'WHERE n.company_id IS NULL AND n.contact_id IS NULL'
  } else if (filter === 'tagged') {
    whereClause = 'WHERE (n.company_id IS NOT NULL OR n.contact_id IS NOT NULL)'
  } else if (filter === 'unfoldered') {
    whereClause = "WHERE (n.folder_path IS NULL OR n.folder_path = '')"
  }

  const meetingClause = hideClaimedMeetingNotes ? CLAIMED_MEETING_FILTER : ''

  // Combine filter clause, folder clause, dedup filter, and optional meeting filter
  const combined = whereClause
    ? `${whereClause} ${folderClause} ${DEDUP_FILTER} ${meetingClause}`
    : `WHERE 1=1 ${folderClause} ${DEDUP_FILTER} ${meetingClause}`

  const rows = db
    .prepare(`${BASE_SELECT} ${combined} ORDER BY n.is_pinned DESC, datetime(n.updated_at) DESC`)
    .all(...folderParams) as NoteRow[]
  return rows.map(rowToNote)
}

export function searchNotes(
  query: string,
  folderPath?: string | null,
  hideClaimedMeetingNotes?: boolean
): Note[] {
  const db = getDatabase()
  const sanitized = query.replace(/["()*^]/g, '').trim()
  if (!sanitized) return listNotes('all', folderPath)

  const { clause: folderClause, params: folderParams } = folderFilter(folderPath)
  const meetingClause = hideClaimedMeetingNotes ? CLAIMED_MEETING_FILTER : ''

  try {
    const rows = db
      .prepare(`
        ${BASE_SELECT}
        JOIN notes_fts nf ON nf.id = n.id
        WHERE notes_fts MATCH ?
        ${folderClause}
        ${DEDUP_FILTER}
        ${meetingClause}
        ORDER BY rank
      `)
      .all(sanitized + '*', ...folderParams) as NoteRow[]
    return rows.map(rowToNote)
  } catch {
    return listNotes('all', folderPath, hideClaimedMeetingNotes)
  }
}

export function getNote(noteId: string): Note | null {
  const db = getDatabase()
  const row = db
    .prepare(`${BASE_SELECT} WHERE n.id = ?`)
    .get(noteId) as NoteRow | undefined
  return row ? rowToNote(row) : null
}

export function createNote(
  data: NoteCreateData & { id?: string },
  userId: string | null = null,
  createdAt?: string | null,
  updatedAt?: string | null
): Note | null {
  const db = getDatabase()
  const id = data.id ?? randomUUID()
  const result = db.prepare(`
    INSERT INTO notes (
      id, title, content, company_id, contact_id, source_meeting_id, theme_id,
      is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at,
      folder_path, import_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ${createdAt ? '?' : "datetime('now')"}, ${updatedAt ? '?' : "datetime('now')"}, ?, ?)
  `).run(
    id,
    data.title ?? null,
    data.content,
    data.companyId ?? null,
    data.contactId ?? null,
    data.sourceMeetingId ?? null,
    data.themeId ?? null,
    userId,
    userId,
    ...(createdAt ? [createdAt] : []),
    ...(updatedAt ? [updatedAt] : []),
    data.folderPath ?? null,
    data.importSource ?? null,
  )
  if (result.changes === 0) return null
  return getNote(id)
}

/**
 * Tag a note with a company or contact association WITHOUT touching updated_at.
 * Used by auto-tagging flows to avoid clobbering the true last-modified date
 * that was set at import time.
 */
export function tagNote(
  noteId: string,
  tag: { companyId?: string | null; contactId?: string | null }
): void {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []
  if (tag.companyId !== undefined) { sets.push('company_id = ?'); params.push(tag.companyId) }
  if (tag.contactId !== undefined) { sets.push('contact_id = ?'); params.push(tag.contactId) }
  if (sets.length === 0) return
  params.push(noteId)
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function updateNote(
  noteId: string,
  data: NoteUpdateData,
  userId: string | null = null
): Note | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title)
  }
  if (data.content !== undefined) {
    sets.push('content = ?')
    params.push(data.content)
  }
  if (data.isPinned !== undefined) {
    sets.push('is_pinned = ?')
    params.push(data.isPinned ? 1 : 0)
  }
  if (data.themeId !== undefined) {
    sets.push('theme_id = ?')
    params.push(data.themeId)
  }
  if (data.companyId !== undefined) {
    sets.push('company_id = ?')
    params.push(data.companyId)
  }
  if (data.contactId !== undefined) {
    sets.push('contact_id = ?')
    params.push(data.contactId)
  }
  if (data.folderPath !== undefined) {
    sets.push('folder_path = ?')
    params.push(data.folderPath)
  }

  if (sets.length === 0) return getNote(noteId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(noteId)
  db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getNote(noteId)
}

export function deleteNote(noteId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
  return result.changes > 0
}

export function listFolders(): string[] {
  const db = getDatabase()
  // UNION: folders derived from notes + user-created empty folders in note_folders
  const rows = db
    .prepare(`
      SELECT DISTINCT path FROM (
        SELECT folder_path AS path FROM notes
        WHERE folder_path IS NOT NULL AND folder_path != ''
        UNION
        SELECT path FROM note_folders
      )
      ORDER BY path ASC
    `)
    .all() as { path: string }[]
  return rows.map(r => r.path)
}

export function createFolder(path: string): void {
  const db = getDatabase()
  db.prepare('INSERT OR IGNORE INTO note_folders (path) VALUES (?)').run(path)
}

export function renameFolder(oldPath: string, newPath: string): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    // Update all notes with the old path or its children (prefix replacement via SUBSTR)
    db.prepare(`
      UPDATE notes
      SET folder_path = ? || SUBSTR(folder_path, LENGTH(?) + 1)
      WHERE folder_path = ? OR folder_path GLOB ?
    `).run(newPath, oldPath, oldPath, oldPath + '/*')

    // For note_folders (path is PK so must delete + re-insert)
    const oldFolderPaths = db.prepare(`
      SELECT path FROM note_folders WHERE path = ? OR path GLOB ?
    `).all(oldPath, oldPath + '/*') as { path: string }[]

    for (const { path } of oldFolderPaths) {
      const newFolderPath = newPath + path.slice(oldPath.length)
      db.prepare('DELETE FROM note_folders WHERE path = ?').run(path)
      db.prepare('INSERT OR IGNORE INTO note_folders (path) VALUES (?)').run(newFolderPath)
    }
  })
  tx()
}

export function deleteFolder(path: string): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    // Clear folder_path on all notes in this folder and its children
    db.prepare(`
      UPDATE notes SET folder_path = NULL
      WHERE folder_path = ? OR folder_path GLOB ?
    `).run(path, path + '/*')

    db.prepare(`
      DELETE FROM note_folders WHERE path = ? OR path GLOB ?
    `).run(path, path + '/*')
  })
  tx()
}

export function getFolderCounts(
  hideClaimedMeetingNotes?: boolean
): { folderPath: string | null; count: number }[] {
  const db = getDatabase()
  const meetingClause = hideClaimedMeetingNotes ? CLAIMED_MEETING_FILTER : ''
  return db
    .prepare(`
      SELECT n.folder_path AS folderPath, COUNT(*) as count
      FROM notes n
      WHERE 1=1
      ${DEDUP_FILTER}
      ${meetingClause}
      GROUP BY n.folder_path
    `)
    .all() as { folderPath: string | null; count: number }[]
}

export function listImportSources(): string[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT DISTINCT import_source
      FROM notes
      WHERE import_source IS NOT NULL
      ORDER BY import_source ASC
    `)
    .all() as { import_source: string }[]
  return rows.map(r => r.import_source)
}
