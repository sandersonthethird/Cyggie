import type Database from 'better-sqlite3'
import { extractLinkedinUrlsFromText } from '../repositories/contact-utils'

/**
 * One-time data repair: clear LinkedIn URLs that were incorrectly copied from
 * the app owner onto other contacts.
 *
 * Root cause: enrichment pipelines (LLM summary extraction, email-based
 * LinkedIn scan) never filtered out the app owner as a meeting attendee.
 * When the owner's LinkedIn URL appeared in meeting notes or email signatures,
 * it was attributed to co-attendee contacts.
 *
 * Three strategies, run in order:
 *
 *  A) Owner has a contact record: use that contact's linkedin_url.
 *
 *  B) Owner has no contact record: extract LinkedIn URL from emails SENT BY
 *     the owner's address (their outbound email signatures contain their URL).
 *     Uses extractLinkedinUrlsFromText which handles both https:// and
 *     protocol-less URLs (e.g. www.linkedin.com/in/...).
 *
 *  C) Fallback (always runs): clear ALL LinkedIn URLs whose normalized slug
 *     appears on more than one contact. LinkedIn URLs are unique per person —
 *     any slug shared across contacts is contaminated data.
 *
 * URL comparison uses toLinkedinSlug() to normalize away protocol/www/trailing
 * slash differences (e.g. "www.linkedin.com/in/foo/" and
 * "https://linkedin.com/in/foo" both normalize to "in/foo").
 */

/** Extract the path portion after linkedin.com/ for protocol-agnostic comparison. */
function toLinkedinSlug(url: string): string | null {
  const m = url.match(/linkedin\.com\/(.+)/i)
  if (!m) return null
  return m[1].replace(/\/$/, '').toLowerCase().trim()
}

export function runRepairOwnerLinkedinUrlMigration(db: Database.Database): void {
  // Look up the owner's email from settings
  const settingRow = db
    .prepare(`SELECT value FROM settings WHERE key = 'currentUserEmail' LIMIT 1`)
    .get() as { value: string } | undefined

  const ownerEmail = settingRow?.value?.trim().toLowerCase()

  let ownerLinkedinUrl: string | null = null
  let ownerContactId: string | null = null

  if (ownerEmail) {
    // Strategy A: find the owner's contact record (checks both email columns)
    const ownerContact = db
      .prepare(
        `SELECT c.id, c.linkedin_url
         FROM contacts c
         WHERE c.linkedin_url IS NOT NULL
           AND trim(c.linkedin_url) <> ''
           AND (
             lower(trim(c.email)) = ?
             OR EXISTS (
               SELECT 1 FROM contact_emails ce
               WHERE ce.contact_id = c.id
                 AND lower(trim(ce.email)) = ?
             )
           )
         LIMIT 1`,
      )
      .get(ownerEmail, ownerEmail) as { id: string; linkedin_url: string } | undefined

    if (ownerContact) {
      ownerLinkedinUrl = ownerContact.linkedin_url
      ownerContactId = ownerContact.id
    } else {
      // Strategy B: extract LinkedIn URL from emails sent by the owner's address.
      // extractLinkedinUrlsFromText handles both https:// and protocol-less URLs.
      const emailRows = db
        .prepare(
          `SELECT body_text, snippet
           FROM email_messages
           WHERE lower(trim(from_email)) = ?
             AND (body_text IS NOT NULL OR snippet IS NOT NULL)
           ORDER BY datetime(COALESCE(received_at, sent_at, created_at)) DESC
           LIMIT 50`,
        )
        .all(ownerEmail) as Array<{ body_text: string | null; snippet: string | null }>

      for (const row of emailRows) {
        const urls = extractLinkedinUrlsFromText(row.body_text ?? row.snippet)
        if (urls.length > 0) {
          ownerLinkedinUrl = urls[0]
          break
        }
      }
    }
  }

  // Fetch all contacts that have a LinkedIn URL — used by both Strategies A/B and C
  const allWithUrl = db
    .prepare(
      `SELECT id, linkedin_url FROM contacts WHERE linkedin_url IS NOT NULL AND trim(linkedin_url) != ''`,
    )
    .all() as Array<{ id: string; linkedin_url: string }>

  // Strategies A & B: clear contacts whose slug matches the owner's slug
  if (ownerLinkedinUrl) {
    const ownerSlug = toLinkedinSlug(ownerLinkedinUrl)
    if (!ownerSlug) {
      console.log(`[migration-062] Could not extract slug from owner URL — skipping A/B clear`)
    } else {
      const toNull = allWithUrl.filter((c) => {
        if (ownerContactId && c.id === ownerContactId) return false
        return toLinkedinSlug(c.linkedin_url) === ownerSlug
      })

      if (toNull.length > 0) {
        const ids = toNull.map((c) => c.id)
        const placeholders = ids.map(() => '?').join(', ')
        const result = db
          .prepare(
            `UPDATE contacts SET linkedin_url = NULL, updated_at = datetime('now') WHERE id IN (${placeholders})`,
          )
          .run(...ids)
        console.log(`[migration-062] Cleared owner LinkedIn URL from ${result.changes} contact(s)`)
      }
    }
  } else if (ownerEmail) {
    console.log(
      `[migration-062] Could not resolve owner LinkedIn URL for ${ownerEmail} — running Strategy C only`,
    )
  }

  // Strategy C: clear ALL LinkedIn URLs whose normalized slug appears on 2+ contacts.
  // LinkedIn URLs are unique per person — any shared slug is contaminated.
  const slugToIds = new Map<string, string[]>()
  for (const c of allWithUrl) {
    const slug = toLinkedinSlug(c.linkedin_url)
    if (!slug) continue
    const existing = slugToIds.get(slug) ?? []
    existing.push(c.id)
    slugToIds.set(slug, existing)
  }

  const stratCIds: string[] = []
  for (const [, ids] of slugToIds) {
    if (ids.length > 1) {
      // Exclude the owner's own contact — their URL is legitimately theirs
      const toClear = ownerContactId ? ids.filter((id) => id !== ownerContactId) : ids
      stratCIds.push(...toClear)
    }
  }

  if (stratCIds.length > 0) {
    const placeholders = stratCIds.map(() => '?').join(', ')
    const result = db
      .prepare(
        `UPDATE contacts SET linkedin_url = NULL, updated_at = datetime('now') WHERE id IN (${placeholders})`,
      )
      .run(...stratCIds)
    console.log(
      `[migration-062] Strategy C: cleared ${result.changes} contact(s) with shared LinkedIn URL slug`,
    )
  }
}
