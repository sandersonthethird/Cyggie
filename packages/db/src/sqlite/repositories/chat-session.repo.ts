import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import { logAudit } from './audit.repo'
import type { ChatContextKind } from '@shared/utils/chat-context'

const PREVIEW_MAX = 120
const TITLE_MAX = 80
const ATTACHMENTS_JSON_MAX_BYTES = 64 * 1024

export interface ChatSession {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  previewText: string | null
  messageCount: number
  isActive: boolean
  isPinned: boolean
  isArchived: boolean
  // Anthropic prompt-caching toggle. See migration 103.
  cacheEnabled: boolean
  lastMessageAt: string
  createdAt: string
  updatedAt: string
}

export interface ChatSessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachmentsJson: string | null
  createdAt: string
}

export interface ChatSearchResult {
  sessionId: string
  messageId: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  snippet: string
  lastMessageAt: string
}

interface SessionRow {
  id: string
  context_id: string
  context_kind: ChatContextKind
  context_label: string | null
  title: string | null
  preview_text: string | null
  message_count: number
  is_active: number
  is_pinned: number
  is_archived: number
  cache_enabled: number
  last_message_at: string
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  attachments_json: string | null
  created_at: string
}

function mapSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    contextId: row.context_id,
    contextKind: row.context_kind,
    contextLabel: row.context_label,
    title: row.title,
    previewText: row.preview_text,
    messageCount: row.message_count,
    isActive: row.is_active === 1,
    isPinned: row.is_pinned === 1,
    isArchived: row.is_archived === 1,
    cacheEnabled: row.cache_enabled === 1,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: MessageRow): ChatSessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    attachmentsJson: row.attachments_json,
    createdAt: row.created_at,
  }
}

function refreshContextLabel(
  contextId: string,
  contextKind: ChatContextKind
): string | null {
  const db = getDatabase()
  if (contextKind === 'company') {
    const id = contextId.startsWith('company:') ? contextId.slice('company:'.length) : contextId
    const row = db.prepare(`SELECT canonical_name FROM org_companies WHERE id = ?`).get(id) as
      | { canonical_name: string }
      | undefined
    return row?.canonical_name ?? null
  }
  if (contextKind === 'contact') {
    const id = contextId.startsWith('contact:') ? contextId.slice('contact:'.length) : contextId
    const row = db.prepare(`SELECT full_name FROM contacts WHERE id = ?`).get(id) as
      | { full_name: string | null }
      | undefined
    return row?.full_name ?? null
  }
  if (contextKind === 'meeting') {
    const row = db.prepare(`SELECT title FROM meetings WHERE id = ?`).get(contextId) as
      | { title: string }
      | undefined
    return row?.title ?? null
  }
  if (contextKind === 'global') {
    return 'Global'
  }
  return null
}

export function getOrCreateActive(
  contextId: string,
  contextKind: ChatContextKind,
  contextLabel: string | null,
  userId: string | null = null
): ChatSession {
  if (!contextId) throw new Error('contextId is required')
  const db = getDatabase()

  const existing = db
    .prepare(
      `SELECT id, context_id, context_kind, context_label, title, preview_text,
              message_count, is_active, is_pinned, is_archived, cache_enabled,
              last_message_at, created_at, updated_at
       FROM chat_sessions
       WHERE context_id = ? AND is_active = 1
       LIMIT 1`
    )
    .get(contextId) as SessionRow | undefined

  if (existing) return mapSession(existing)

  const id = randomUUID()
  const label = contextLabel ?? refreshContextLabel(contextId, contextKind)

  try {
    db.prepare(
      `INSERT INTO chat_sessions (
        id, context_id, context_kind, context_label,
        is_active, is_pinned, is_archived, cache_enabled, message_count,
        last_message_at, created_at, updated_at,
        created_by_user_id, updated_by_user_id
      ) VALUES (?, ?, ?, ?, 1, 0, 0, 1, 0, datetime('now'), datetime('now'), datetime('now'), ?, ?)`
    ).run(id, contextId, contextKind, label, userId, userId)
  } catch (err) {
    // UNIQUE INDEX race: another caller created the active session first.
    const racer = db
      .prepare(
        `SELECT id, context_id, context_kind, context_label, title, preview_text,
                message_count, is_active, is_pinned, is_archived, cache_enabled,
                last_message_at, created_at, updated_at
         FROM chat_sessions
         WHERE context_id = ? AND is_active = 1
         LIMIT 1`
      )
      .get(contextId) as SessionRow | undefined
    if (racer) return mapSession(racer)
    throw err
  }

  logAudit(userId, 'chat_session', id, 'create', { contextId, contextKind })

  const created = db
    .prepare(
      `SELECT id, context_id, context_kind, context_label, title, preview_text,
              message_count, is_active, is_pinned, is_archived, cache_enabled,
              last_message_at, created_at, updated_at
       FROM chat_sessions WHERE id = ?`
    )
    .get(id) as SessionRow

  return mapSession(created)
}

export function appendMessage(
  data: {
    sessionId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    attachmentsJson?: string | null
  },
  userId: string | null = null
): ChatSessionMessage {
  if (!data.sessionId) throw new Error('sessionId is required')
  if (!data.content) throw new Error('content is required')
  const db = getDatabase()

  let attachmentsJson = data.attachmentsJson ?? null
  if (attachmentsJson && Buffer.byteLength(attachmentsJson, 'utf8') > ATTACHMENTS_JSON_MAX_BYTES) {
    attachmentsJson = null
  }

  const messageId = randomUUID()
  const previewText = data.content.slice(0, PREVIEW_MAX)

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_session_messages (id, session_id, role, content, attachments_json, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(messageId, data.sessionId, data.role, data.content, attachmentsJson)

    const session = db
      .prepare(`SELECT context_id, context_kind FROM chat_sessions WHERE id = ?`)
      .get(data.sessionId) as { context_id: string; context_kind: ChatContextKind } | undefined

    const refreshedLabel = session
      ? refreshContextLabel(session.context_id, session.context_kind)
      : null

    db.prepare(
      `UPDATE chat_sessions
         SET last_message_at = datetime('now'),
             updated_at      = datetime('now'),
             updated_by_user_id = ?,
             message_count   = message_count + 1,
             preview_text    = ?,
             context_label   = COALESCE(?, context_label)
       WHERE id = ?`
    ).run(userId, previewText, refreshedLabel, data.sessionId)
  })

  try {
    txn()
  } catch (err) {
    logAudit(userId, 'chat_session_message', messageId, 'create', {
      sessionId: data.sessionId,
      role: data.role,
      failed: true,
    })
    throw err
  }

  const row = db
    .prepare(
      `SELECT id, session_id, role, content, attachments_json, created_at
       FROM chat_session_messages WHERE id = ?`
    )
    .get(messageId) as MessageRow

  return mapMessage(row)
}

export function endActive(contextId: string, userId: string | null = null): void {
  if (!contextId) return
  const db = getDatabase()

  const active = db
    .prepare(
      `SELECT id, message_count FROM chat_sessions
       WHERE context_id = ? AND is_active = 1`
    )
    .get(contextId) as { id: string; message_count: number } | undefined

  if (!active) return

  if (active.message_count === 0) {
    // Empty active session — prune it instead of leaving a dangling row.
    db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(active.id)
    logAudit(userId, 'chat_session', active.id, 'delete', { reason: 'empty-on-end' })
    return
  }

  db.prepare(
    `UPDATE chat_sessions
       SET is_active = 0,
           updated_at = datetime('now'),
           updated_by_user_id = ?
     WHERE id = ?`
  ).run(userId, active.id)

  logAudit(userId, 'chat_session', active.id, 'update', { endedActive: true })
}

export function createNew(
  contextId: string,
  contextKind: ChatContextKind,
  contextLabel: string | null,
  userId: string | null = null
): ChatSession {
  endActive(contextId, userId)
  return getOrCreateActive(contextId, contextKind, contextLabel, userId)
}

export function listRecent(opts: {
  contextId?: string | null
  limit?: number
  offset?: number
  pinnedOnly?: boolean
} = {}): ChatSession[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const offset = Math.max(0, opts.offset ?? 0)
  const db = getDatabase()

  if (opts.pinnedOnly) {
    const rows = db
      .prepare(
        `SELECT id, context_id, context_kind, context_label, title, preview_text,
                message_count, is_active, is_pinned, is_archived, cache_enabled,
                last_message_at, created_at, updated_at
         FROM chat_sessions
         WHERE is_archived = 0 AND is_pinned = 1
         ORDER BY datetime(last_message_at) DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as SessionRow[]
    return rows.map(mapSession)
  }

  if (opts.contextId) {
    const rows = db
      .prepare(
        `SELECT id, context_id, context_kind, context_label, title, preview_text,
                message_count, is_active, is_pinned, is_archived, cache_enabled,
                last_message_at, created_at, updated_at
         FROM chat_sessions
         WHERE is_archived = 0 AND context_id = ?
         ORDER BY is_pinned DESC, datetime(last_message_at) DESC
         LIMIT ? OFFSET ?`
      )
      .all(opts.contextId, limit, offset) as SessionRow[]
    return rows.map(mapSession)
  }

  const rows = db
    .prepare(
      `SELECT id, context_id, context_kind, context_label, title, preview_text,
              message_count, is_active, is_pinned, is_archived, cache_enabled,
              last_message_at, created_at, updated_at
       FROM chat_sessions
       WHERE is_archived = 0
       ORDER BY is_pinned DESC, datetime(last_message_at) DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as SessionRow[]
  return rows.map(mapSession)
}

export function getSession(sessionId: string): ChatSession | null {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT id, context_id, context_kind, context_label, title, preview_text,
              message_count, is_active, is_pinned, is_archived, cache_enabled,
              last_message_at, created_at, updated_at
       FROM chat_sessions WHERE id = ?`
    )
    .get(sessionId) as SessionRow | undefined
  return row ? mapSession(row) : null
}

export function getActiveForContext(contextId: string): ChatSession | null {
  if (!contextId) return null
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT id, context_id, context_kind, context_label, title, preview_text,
              message_count, is_active, is_pinned, is_archived, cache_enabled,
              last_message_at, created_at, updated_at
       FROM chat_sessions
       WHERE context_id = ? AND is_active = 1
       LIMIT 1`
    )
    .get(contextId) as SessionRow | undefined
  return row ? mapSession(row) : null
}

export function loadMessages(sessionId: string, limit = 200, offset = 0): ChatSessionMessage[] {
  if (!sessionId) return []
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT id, session_id, role, content, attachments_json, created_at
       FROM chat_session_messages
       WHERE session_id = ?
       ORDER BY datetime(created_at) ASC
       LIMIT ? OFFSET ?`
    )
    .all(sessionId, limit, offset) as MessageRow[]
  return rows.map(mapMessage)
}

function escapeFtsQuery(query: string): string {
  // Wrap in double-quotes for phrase-match. Escape any embedded double quotes
  // by doubling them (per FTS5 grammar).
  const trimmed = query.trim().slice(0, 200)
  const escaped = trimmed.replace(/"/g, '""')
  return `"${escaped}"`
}

export function search(query: string, limit = 50): ChatSearchResult[] {
  if (!query || query.trim().length < 2) return []
  const db = getDatabase()
  const cappedLimit = Math.max(1, Math.min(limit, 100))

  const ftsQuery = escapeFtsQuery(query)

  try {
    const rows = db
      .prepare(
        `SELECT
           s.id              AS session_id,
           m.id              AS message_id,
           s.context_id      AS context_id,
           s.context_kind    AS context_kind,
           s.context_label   AS context_label,
           s.title           AS title,
           snippet(chat_session_messages_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
           s.last_message_at AS last_message_at
         FROM chat_session_messages_fts fts
         JOIN chat_session_messages m ON m.id = fts.message_id
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE chat_session_messages_fts MATCH ?
           AND s.is_archived = 0
         ORDER BY rank, datetime(s.last_message_at) DESC
         LIMIT ?`
      )
      .all(ftsQuery, cappedLimit) as Array<{
      session_id: string
      message_id: string
      context_id: string
      context_kind: ChatContextKind
      context_label: string | null
      title: string | null
      snippet: string
      last_message_at: string
    }>

    return rows.map((r) => ({
      sessionId: r.session_id,
      messageId: r.message_id,
      contextId: r.context_id,
      contextKind: r.context_kind,
      contextLabel: r.context_label,
      title: r.title,
      snippet: r.snippet,
      lastMessageAt: r.last_message_at,
    }))
  } catch (err) {
    // FTS5 syntax error or other failure — fall back to LIKE on title.
    console.warn('[chat-session.repo] FTS5 search failed; falling back to LIKE on title', err)
    const likePattern = `%${query.trim().slice(0, 200)}%`
    const rows = db
      .prepare(
        `SELECT id, context_id, context_kind, context_label, title, last_message_at
         FROM chat_sessions
         WHERE is_archived = 0 AND title LIKE ?
         ORDER BY datetime(last_message_at) DESC
         LIMIT ?`
      )
      .all(likePattern, cappedLimit) as Array<{
      id: string
      context_id: string
      context_kind: ChatContextKind
      context_label: string | null
      title: string | null
      last_message_at: string
    }>
    return rows.map((r) => ({
      sessionId: r.id,
      messageId: '',
      contextId: r.context_id,
      contextKind: r.context_kind,
      contextLabel: r.context_label,
      title: r.title,
      snippet: r.title ?? '',
      lastMessageAt: r.last_message_at,
    }))
  }
}

export function rename(sessionId: string, title: string, userId: string | null = null): ChatSession | null {
  if (!sessionId) throw new Error('sessionId is required')
  const trimmed = title.trim().slice(0, TITLE_MAX)
  if (!trimmed) throw new Error('title cannot be empty')
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET title = ?, updated_at = datetime('now'), updated_by_user_id = ?
     WHERE id = ?`
  ).run(trimmed, userId, sessionId)
  logAudit(userId, 'chat_session', sessionId, 'update', { rename: true })
  return getSession(sessionId)
}

export function setTitleIfMissing(sessionId: string, title: string): void {
  if (!sessionId || !title) return
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET title = ?, updated_at = datetime('now')
     WHERE id = ? AND (title IS NULL OR title = '')`
  ).run(title.slice(0, TITLE_MAX), sessionId)
}

export function pin(sessionId: string, userId: string | null = null): void {
  if (!sessionId) throw new Error('sessionId is required')
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET is_pinned = 1, updated_at = datetime('now'), updated_by_user_id = ?
     WHERE id = ?`
  ).run(userId, sessionId)
  logAudit(userId, 'chat_session', sessionId, 'update', { pinned: true })
}

export function unpin(sessionId: string, userId: string | null = null): void {
  if (!sessionId) throw new Error('sessionId is required')
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET is_pinned = 0, updated_at = datetime('now'), updated_by_user_id = ?
     WHERE id = ?`
  ).run(userId, sessionId)
  logAudit(userId, 'chat_session', sessionId, 'update', { pinned: false })
}

export function setCacheEnabled(
  sessionId: string,
  enabled: boolean,
  userId: string | null = null,
): void {
  if (!sessionId) throw new Error('sessionId is required')
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET cache_enabled = ?, updated_at = datetime('now'), updated_by_user_id = ?
     WHERE id = ?`,
  ).run(enabled ? 1 : 0, userId, sessionId)
  logAudit(userId, 'chat_session', sessionId, 'update', { cacheEnabled: enabled })
}

export function archive(sessionId: string, userId: string | null = null): void {
  if (!sessionId) throw new Error('sessionId is required')
  const db = getDatabase()
  db.prepare(
    `UPDATE chat_sessions
       SET is_archived = 1, is_active = 0, updated_at = datetime('now'), updated_by_user_id = ?
     WHERE id = ?`
  ).run(userId, sessionId)
  logAudit(userId, 'chat_session', sessionId, 'update', { archived: true })
}

export function deleteSession(sessionId: string, userId: string | null = null): void {
  if (!sessionId) throw new Error('sessionId is required')
  const db = getDatabase()
  db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(sessionId)
  logAudit(userId, 'chat_session', sessionId, 'delete', null)
}

export function getMessageCount(sessionId: string): number {
  if (!sessionId) return 0
  const db = getDatabase()
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_session_messages WHERE session_id = ?`)
    .get(sessionId) as { n: number }
  return row.n
}
