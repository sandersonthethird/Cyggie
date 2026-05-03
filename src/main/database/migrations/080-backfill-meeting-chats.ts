import type Database from 'better-sqlite3'

interface LegacyChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface MeetingRow {
  id: string
  title: string
  chat_messages: string | null
  date: string | null
  updated_at: string | null
}

export function runBackfillMeetingChatsMigration(db: Database.Database): void {
  // Idempotent: deterministic IDs (`mtg-chat-<id>`, `mtg-msg-<id>-<n>`) +
  // INSERT OR IGNORE means re-runs are no-ops for the rows themselves. We
  // also self-heal timestamps below for any backfilled-but-not-yet-touched
  // rows — earlier versions of this migration stamped `datetime('now')`
  // for last_message_at, which made all chats appear to be "just now".
  const meetings = db
    .prepare(
      `SELECT id, title, chat_messages, date, updated_at
       FROM meetings
       WHERE chat_messages IS NOT NULL AND chat_messages != ''`
    )
    .all() as MeetingRow[]

  if (meetings.length === 0) return

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO chat_sessions (
      id, context_id, context_kind, context_label, title,
      preview_text, message_count, is_active, is_pinned, is_archived,
      last_message_at, created_at, updated_at
    ) VALUES (
      ?, ?, 'meeting', ?, ?,
      ?, ?, 0, 0, 0,
      ?, ?, ?
    )
  `)

  // Self-heal pre-existing backfilled rows that still have their migration-time
  // timestamp. Only updates rows the user hasn't touched (created_at = updated_at).
  const healSession = db.prepare(`
    UPDATE chat_sessions
       SET last_message_at = ?, updated_at = ?
     WHERE id = ? AND created_at = updated_at
  `)

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO chat_session_messages (
      id, session_id, role, content, attachments_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, ?)
  `)

  let backfilled = 0
  let skipped = 0

  const transaction = db.transaction(() => {
    for (const meeting of meetings) {
      let messages: LegacyChatMessage[]
      try {
        const parsed = JSON.parse(meeting.chat_messages as string)
        if (!Array.isArray(parsed) || parsed.length === 0) {
          continue
        }
        messages = parsed as LegacyChatMessage[]
      } catch (err) {
        console.warn(
          `[migration 080] skipping meeting ${meeting.id}: malformed chat_messages JSON`,
          err
        )
        skipped++
        continue
      }

      const sessionId = `mtg-chat-${meeting.id}`
      const firstUser = messages.find((m) => m.role === 'user')
      const title = firstUser ? firstUser.content.slice(0, 80) : meeting.title

      const lastMessage = messages[messages.length - 1]
      const previewText = (lastMessage?.content ?? '').slice(0, 120)

      // Use the meeting's actual timestamp so backfilled chats sort by recency
      // alongside any new chats. Prefer updated_at (when the chat was last
      // saved); fall back to date (the meeting's occurrence date).
      const ts = meeting.updated_at ?? meeting.date ?? new Date().toISOString()

      insertSession.run(
        sessionId,
        meeting.id,
        meeting.title ?? 'Meeting',
        title,
        previewText,
        messages.length,
        ts,
        ts,
        ts
      )

      // Self-heal: rows backfilled by an earlier version of this migration
      // had `datetime('now')` for last_message_at. Reset them now if untouched.
      healSession.run(ts, ts, sessionId)

      messages.forEach((msg, ordinal) => {
        const messageId = `mtg-msg-${meeting.id}-${ordinal}`
        insertMessage.run(messageId, sessionId, msg.role, msg.content, ts)
      })

      backfilled++
      if (backfilled % 100 === 0) {
        console.log(`[migration 080] backfilled ${backfilled} meeting chats…`)
      }
    }
  })

  transaction()

  if (backfilled > 0 || skipped > 0) {
    console.log(
      `[migration 080] backfill complete: ${backfilled} meeting chats migrated, ${skipped} skipped`
    )
  }
}
