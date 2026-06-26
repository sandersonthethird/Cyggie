import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_135_meeting_attendee_emails_v1'

/**
 * `meeting_attendee_emails` — a LOCAL, derived, NON-synced lookup table that
 * explodes each meeting's `attendee_emails` JSON array into one indexed row per
 * normalized email. It exists purely to make the contact "activity touchpoint"
 * computation fast.
 *
 * WHY: the Contacts list runs `TOUCHPOINT_CTES` (contact.repo.ts) synchronously
 * on the Electron main thread on every mount. Its `meeting_touch` branch used to
 * match contacts to meetings with a correlated `json_each(attendee_emails)`
 * scan — O(contact_emails × meetings), which measured ~1s at ~5k meetings and
 * blocked the main process long enough to beachball the whole app. Joining this
 * pre-exploded, indexed table instead is an equijoin: ~3ms at the same scale.
 *
 *   meetings.attendee_emails = '["A@x.com"," b@x ",""]'
 *        │  (trigger: json_each + lower(trim), skip blanks, DISTINCT)
 *        ▼
 *   meeting_attendee_emails(meeting_id, email_lc)  ── idx_mae_email (email_lc)
 *        ▲                                          └─ idx_mae_meeting (meeting_id)
 *        │  joined by meeting_touch ON mae.email_lc = contact_email_keys.email
 *
 * KEPT IN SYNC BY TRIGGERS, not app code: AFTER INSERT/UPDATE/DELETE on
 * `meetings`. This deliberately avoids coupling every meeting write path (local
 * edit, sync-pull apply, launch backfill) — any DML on `meetings` maintains the
 * derived rows automatically, so the table can't drift out of sync.
 *
 * NOT an owned/synced table (like `outbox`/`attachment_uploads`): no lamport, no
 * outbox, never reaches Neon. Each desktop rebuilds it locally from its own
 * meetings via these triggers + the one-time backfill below.
 *
 * DRIFT GUARD: the trigger's `lower(trim(...))` normalization and the
 * `email_lc` semantics MUST match the `lower(trim(...))` used for
 * `contact_email_keys` in `TOUCHPOINT_CTES`, or the join silently misses and
 * touchpoints regress to the `updated_at` fallback. Edit both together; the
 * contact.repo.ts golden + plan-pinning tests assert the join still resolves and
 * uses idx_mae_email.
 */
export function runMeetingAttendeeEmailsMigration(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_attendee_emails (
      meeting_id TEXT NOT NULL,
      email_lc   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mae_email   ON meeting_attendee_emails(email_lc);
    CREATE INDEX IF NOT EXISTS idx_mae_meeting ON meeting_attendee_emails(meeting_id);

    -- Triggers keep the derived rows in lockstep with meetings.attendee_emails.
    -- email normalization (lower(trim), skip blanks, DISTINCT) MUST match the
    -- contact_email_keys side in TOUCHPOINT_CTES.
    CREATE TRIGGER IF NOT EXISTS trg_mae_after_insert
    AFTER INSERT ON meetings BEGIN
      INSERT INTO meeting_attendee_emails (meeting_id, email_lc)
        SELECT DISTINCT NEW.id, lower(trim(e.value))
        FROM json_each(COALESCE(NEW.attendee_emails, '[]')) e
        WHERE trim(e.value) <> '';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_mae_after_delete
    AFTER DELETE ON meetings BEGIN
      DELETE FROM meeting_attendee_emails WHERE meeting_id = OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_mae_after_update
    AFTER UPDATE ON meetings BEGIN
      DELETE FROM meeting_attendee_emails WHERE meeting_id = OLD.id;
      INSERT INTO meeting_attendee_emails (meeting_id, email_lc)
        SELECT DISTINCT NEW.id, lower(trim(e.value))
        FROM json_each(COALESCE(NEW.attendee_emails, '[]')) e
        WHERE trim(e.value) <> '';
    END;
  `)

  // One-time backfill of existing meetings (triggers only cover future writes).
  db.exec(`
    DELETE FROM meeting_attendee_emails;
    INSERT INTO meeting_attendee_emails (meeting_id, email_lc)
      SELECT DISTINCT m.id, lower(trim(e.value))
      FROM meetings m, json_each(COALESCE(m.attendee_emails, '[]')) e
      WHERE trim(e.value) <> '';
  `)

  db.exec(`ANALYZE;`)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
