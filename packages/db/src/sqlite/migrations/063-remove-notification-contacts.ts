import type Database from 'better-sqlite3'

/**
 * One-time data repair: delete contacts whose email address belongs to a known
 * notification sender or bot (e.g. calendar-notification@google.com,
 * noreply@*, no-reply@*, etc.).
 *
 * Root cause: buildCandidateMap did not filter out notification addresses when
 * processing meeting attendees.  Google Calendar embeds a
 * `calendar-notification@google.com` entry in some invite attendee lists,
 * which was incorrectly turned into a contact record.
 */

const NOTIFICATION_PREFIXES = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notification',
  'notifications',
  'mailer-daemon',
  'postmaster',
  'calendar-notification',
  'invitations-noreply',
  'bounce',
  'bounces',
  'automailer',
  'automated',
]

export function runRemoveNotificationContactsMigration(db: Database.Database): void {
  const likePatterns = NOTIFICATION_PREFIXES.map((p) => `lower(trim(email)) LIKE '${p}@%'`)
  const whereClause = likePatterns.join(' OR ')

  // Collect IDs of contacts to remove
  const toDelete = db
    .prepare(`SELECT id FROM contacts WHERE ${whereClause}`)
    .all() as Array<{ id: string }>

  if (toDelete.length === 0) return

  const ids = toDelete.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(', ')

  // Remove junction rows first (foreign key safety)
  db.prepare(`DELETE FROM org_company_contacts WHERE contact_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM contact_emails WHERE contact_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids)

  console.log(`[migration-063] Removed ${ids.length} notification/bot contact(s)`)
}
