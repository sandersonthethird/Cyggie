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
import { runCompanyOsCoreMigration } from './migrations/012-company-os-core'
import { runCompanyOsEmailMigration } from './migrations/013-company-os-email'
import { runCompanyOsArtifactsMigration } from './migrations/014-company-os-artifacts'
import { runCompanyOsChatMigration } from './migrations/015-company-os-chat'
import { runCompanyOsNotesMigration } from './migrations/016-company-os-notes'
import { runCompanyOsMemoMigration } from './migrations/017-company-os-memo'
import { runCompanyOsThesisMigration } from './migrations/018-company-os-thesis'
import { runCompanyOsBackfillMigration } from './migrations/019-company-os-backfill'
import { runCompanyClassificationMigration } from './migrations/020-company-classification'
import { runCompanyDomainNormalizationMigration } from './migrations/021-company-domain-normalization'
import { runContactMultiEmailMigration } from './migrations/022-contact-multi-email'
import { runContactNamePartsMigration } from './migrations/023-contact-name-parts'

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
    runCompanyOsCoreMigration(db)
    runCompanyOsEmailMigration(db)
    runCompanyOsArtifactsMigration(db)
    runCompanyOsChatMigration(db)
    runCompanyOsNotesMigration(db)
    runCompanyOsMemoMigration(db)
    runCompanyOsThesisMigration(db)
    runCompanyOsBackfillMigration(db)
    runCompanyClassificationMigration(db)
    runCompanyDomainNormalizationMigration(db)
    runContactMultiEmailMigration(db)
    runContactNamePartsMigration(db)
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
