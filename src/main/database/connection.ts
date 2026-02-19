import Database from 'better-sqlite3'
import { getDatabasePath } from '../storage/paths'
import { runMigrations } from './migrations/001-initial-schema'
import { runFtsMigration } from './migrations/002-fts5-tables'
import { runNotesMigration } from './migrations/003-notes-column'
import { runTranscriptSegmentsMigration } from './migrations/004-transcript-segments'
import { runDriveColumnsMigration } from './migrations/005-drive-columns'
import { runAttendeesMigration } from './migrations/006-attendees-column'
import { runChatMessagesMigration } from './migrations/007-chat-messages'
import { runCompaniesMigration } from './migrations/008-companies'
import { runCompaniesCacheMigration } from './migrations/009-companies-cache'
import { runClearCompanyCacheMigration } from './migrations/010-clear-company-cache'
import { runRecordingPathMigration } from './migrations/011-recording-path'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(getDatabasePath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    runFtsMigration(db)
    runNotesMigration(db)
    runTranscriptSegmentsMigration(db)
    runDriveColumnsMigration(db)
    runAttendeesMigration(db)
    runChatMessagesMigration(db)
    runCompaniesMigration(db)
    runCompaniesCacheMigration(db)
    runClearCompanyCacheMigration(db)
    runRecordingPathMigration(db)
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
