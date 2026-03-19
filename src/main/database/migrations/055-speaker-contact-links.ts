import type Database from 'better-sqlite3'

export function runSpeakerContactLinksMigration(db: Database.Database): void {
  // Guard: already migrated
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_speaker_contact_links'`)
    .get()
  if (tableExists) return

  db.transaction(() => {
    db.exec(`
      CREATE TABLE meeting_speaker_contact_links (
        meeting_id    TEXT    NOT NULL REFERENCES meetings(id)  ON DELETE CASCADE,
        speaker_index INTEGER NOT NULL,
        contact_id    TEXT    NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (meeting_id, speaker_index)
      );

      CREATE INDEX idx_speaker_contact_links_contact ON meeting_speaker_contact_links(contact_id);
    `)
  })()

  console.log('[migration-055] Created meeting_speaker_contact_links table')
}
