import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to the three email tables that join
 * the Phase 1.5a sync engine for the lean email→Neon projection (Part B):
 * email_messages, email_company_links, email_contact_links.
 *
 * Email was out-of-scope at migration 096 (sync genesis). The trigger now is
 * gateway/mobile chat-context parity: the desktop-local chat already includes
 * tagged emails, but the gateway (mobile / web) builds context from Neon, which
 * has no email data. Syncing these three tables (with body_text truncated at
 * emit time — see email-sync-backfill.service.ts) closes that gap.
 *
 * Only these three of the nine desktop email tables are synced; email_threads,
 * email_message_participants, email_attachments, email_accounts, and
 * email_theme_links stay desktop-only (the gateway derives thread aggregates
 * from messages and retrieves via the link tables — see schema/email.ts).
 *
 * Each table is also added to OWNED_TABLES in the same change set; see
 * packages/db/src/sync/owned-tables.ts. Idempotent via PRAGMA table_info check.
 */
export function runEmailSyncLamportMigration(db: Database.Database): void {
  for (const table of ['email_messages', 'email_company_links', 'email_contact_links']) {
    const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
      name: string
    }[]
    if (cols.some((c) => c.name === 'lamport')) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
  }
}
