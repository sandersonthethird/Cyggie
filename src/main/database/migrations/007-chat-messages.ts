import type Database from 'better-sqlite3'

export function runChatMessagesMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const hasChatMessages = cols.some((c) => c.name === 'chat_messages')

  if (!hasChatMessages) {
    db.exec('ALTER TABLE meetings ADD COLUMN chat_messages TEXT')
  }
}
