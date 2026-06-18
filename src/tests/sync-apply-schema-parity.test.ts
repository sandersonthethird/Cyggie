/**
 * Schema-parity regression test — the guard that would have caught the
 * meeting/contact down-sync outage.
 *
 * THE BUG IT PREVENTS
 * The sync pull-apply (applyRemoteMeetings / applyRemoteContacts in
 * sync-remote-apply.ts) INSERTs columns — meetings.was_impromptu /
 * scheduled_end_at, contacts.last_meeting_at / last_email_at — that existed on
 * the Postgres side + the sync wire but were never added to the local SQLite
 * migrations. Every /sync/pull meetings & contacts sub-batch therefore threw
 * "table … has no column named …" and rolled back, so NO gateway meeting or
 * contact ever applied to a device (transcripts recorded on mobile never
 * reached desktop). Migration 123 added the columns.
 *
 * WHY THE OLD TESTS MISSED IT
 * sync-remote-apply.test.ts builds its meetings table by HAND-ROLLING a CREATE
 * TABLE that happens to include was_impromptu/scheduled_end_at — so it tested
 * the apply against a schema that didn't match what the real migrations produce.
 *
 * WHAT THIS TEST DOES DIFFERENTLY
 * It builds the schema from the REAL migration chain (runAllMigrations) and runs
 * the REAL apply. applyRemoteRows swallows per-chunk throws (logs tx_rollback,
 * returns appliedCount 0), so a missing column is a SILENT no-apply — we assert
 * the row actually LANDS (appliedCount === 1 AND it's queryable). If the apply
 * ever references a column a migration didn't create, this fails loudly.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import {
  applyRemoteMeetings,
  applyRemoteContacts,
  type PulledMeetingRow,
  type PulledContactRow,
} from '@main/services/sync-remote-apply'

const DEVICE_ID = 'dev-parity'
const USER_ID = 'user-parity'

/** Fresh in-memory DB with the full real migration chain + a sync_state row
 *  (apply asserts the device is registered) + the signed-in user. */
function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runAllMigrations(db)
  db.prepare(
    "INSERT INTO sync_state (device_id, user_id, last_pulled_lamport) VALUES (?, ?, '0')",
  ).run(DEVICE_ID, USER_ID)
  // applyRemoteRows does a `SELECT 1 FROM users WHERE id = ?` pre-check and skips
  // every row if the owning user is absent. Seed it, satisfying all NOT NULL
  // columns (without defaults) generically so this survives future users-table
  // migrations.
  const userCols = db.prepare(`PRAGMA table_info('users')`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: unknown
    pk: number
  }[]
  // Always include `id` (a TEXT PK is notnull=0 in SQLite, so the NOT NULL
  // filter below misses it — yet the FK pre-check looks it up by id).
  const required = userCols.filter(
    (c) => c.name === 'id' || (c.notnull === 1 && c.dflt_value === null),
  )
  const names = required.map((c) => c.name)
  const values = required.map((c) =>
    c.name === 'id' ? USER_ID : /INT|REAL|NUM/i.test(c.type) ? 0 : 'parity',
  )
  db.prepare(
    `INSERT INTO users (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...values)
  return db
}

const meetingRow = (): PulledMeetingRow => ({
  id: 'meeting-parity-1',
  userId: USER_ID,
  title: 'Lora <> Sandy',
  date: '2026-06-12T10:00:00.000Z',
  durationSeconds: 600,
  calendarEventId: null,
  meetingPlatform: null,
  meetingUrl: null,
  location: null,
  transcriptPath: null,
  summaryPath: null,
  recordingPath: null,
  transcriptDriveId: null,
  summaryDriveId: null,
  templateId: null,
  speakerCount: 2,
  speakerMap: {},
  transcriptSegments: [{ speaker: 'A', text: 'hello' }],
  notes: null,
  summary: null,
  attendees: null,
  attendeeEmails: null,
  chatMessages: null,
  companies: null,
  dismissedCompanies: null,
  status: 'transcribed',
  wasImpromptu: true, // exercises the column that was missing
  isGroupEvent: false,
  isGroupEventUserSet: false,
  scheduledEndAt: '2026-06-12T10:10:00.000Z', // exercises the other missing column
  createdAt: '2026-06-12T10:00:00.000Z',
  updatedAt: '2026-06-12T10:00:00.000Z',
  lamport: '100',
})

const contactRow = (): PulledContactRow => ({
  id: 'contact-parity-1',
  userId: USER_ID,
  fullName: 'Lora Example',
  firstName: 'Lora',
  lastName: 'Example',
  normalizedName: 'lora example',
  email: 'lora@example.com',
  phone: null,
  primaryCompanyId: null,
  title: null,
  contactType: null,
  linkedinUrl: null,
  crmContactId: null,
  crmProvider: null,
  twitterHandle: null,
  otherSocials: null,
  city: null,
  state: null,
  timezone: null,
  pronouns: null,
  birthday: null,
  university: null,
  previousCompanies: null,
  workHistory: null,
  educationHistory: null,
  tags: null,
  relationshipStrength: null,
  lastMetEvent: null,
  warmIntroPath: null,
  fundSize: null,
  typicalCheckSizeMin: null,
  typicalCheckSizeMax: null,
  investmentStageFocus: null,
  investmentSectorFocus: null,
  investmentSectorFocusNotes: null,
  proudPortfolioCompanies: null,
  linkedinHeadline: null,
  linkedinSkills: null,
  linkedinEnrichedAt: null,
  talentPipeline: null,
  keyTakeaways: null,
  fieldSources: null,
  notes: null,
  lamport: '100',
  createdAt: '2026-06-12T10:00:00.000Z',
  updatedAt: '2026-06-12T10:00:00.000Z',
})

describe('sync apply ↔ migration schema parity', () => {
  it('applies a pulled meeting against the real migrated schema (no rolled-back chunk)', () => {
    const db = migratedDb()
    const result = applyRemoteMeetings(db, DEVICE_ID, USER_ID, [meetingRow()])
    // An empty appliedIds here would mean the chunk silently rolled back — the
    // exact failure mode of the was_impromptu/scheduled_end_at gap.
    expect(result.appliedIds).toEqual(['meeting-parity-1'])
    expect(result.skippedPreValidation).toBe(0)
    const row = db
      .prepare('SELECT was_impromptu, scheduled_end_at FROM meetings WHERE id = ?')
      .get('meeting-parity-1') as { was_impromptu: number; scheduled_end_at: string } | undefined
    expect(row).toBeDefined()
    expect(row?.was_impromptu).toBe(1)
    expect(row?.scheduled_end_at).toBe('2026-06-12T10:10:00.000Z')
  })

  it('applies a pulled contact against the real migrated schema (no rolled-back chunk)', () => {
    const db = migratedDb()
    const result = applyRemoteContacts(db, DEVICE_ID, USER_ID, [contactRow()])
    expect(result.appliedIds).toEqual(['contact-parity-1'])
    expect(result.skippedPreValidation).toBe(0)
    const row = db
      .prepare('SELECT full_name, email FROM contacts WHERE id = ?')
      .get('contact-parity-1') as { full_name: string; email: string } | undefined
    expect(row).toBeDefined()
    expect(row?.full_name).toBe('Lora Example')
    expect(row?.email).toBe('lora@example.com')
  })
})
