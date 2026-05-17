import type Database from 'better-sqlite3'
import { extractDomainFromEmail } from '../../utils/company-extractor'

/**
 * One-time data repair: remove contacts incorrectly associated with Red Swan
 * Ventures (or any company whose contacts don't match its primary domain).
 *
 * Root cause: the `companyHitsByEmail` enrichment fallback in
 * `enrichContactCandidates` assigned external meeting attendees to the
 * meeting host's company based on meeting co-attendance, without validating
 * that the contact's email domain matched the company's domain.
 *
 * Since Red Swan employees host nearly every meeting in the DB, external
 * attendees accumulated many Red Swan hits and were incorrectly assigned to
 * Red Swan Ventures — resulting in ~331 mis-associated contacts.
 *
 * This migration finds contacts whose email domain does NOT match their
 * assigned company's primary_domain and clears the association.
 * The next enrichExistingContacts() run will re-assign them correctly.
 */
export function runRepairOwnCompanyContactsMigration(db: Database.Database): void {
  // Load all companies that have at least one contact assigned via primary_company_id
  const companiesWithContacts = db
    .prepare(
      `SELECT DISTINCT c.primary_company_id AS id, lower(trim(oc.primary_domain)) AS domain
       FROM contacts c
       JOIN org_companies oc ON oc.id = c.primary_company_id
       WHERE c.primary_company_id IS NOT NULL
         AND oc.primary_domain IS NOT NULL
         AND trim(oc.primary_domain) <> ''`,
    )
    .all() as Array<{ id: string; domain: string }>

  if (companiesWithContacts.length === 0) return

  const clearPrimaryCompany = db.prepare(
    `UPDATE contacts SET primary_company_id = NULL, updated_at = datetime('now') WHERE id = ?`,
  )
  const removeJunctionRow = db.prepare(
    `DELETE FROM org_company_contacts WHERE company_id = ? AND contact_id = ?`,
  )

  let totalRemoved = 0

  for (const company of companiesWithContacts) {
    const linked = db
      .prepare(`SELECT id, email FROM contacts WHERE primary_company_id = ?`)
      .all(company.id) as Array<{ id: string; email: string | null }>

    for (const contact of linked) {
      // Collect all emails: contact_emails table + contacts.email fallback
      const emailRows = db
        .prepare(
          `SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY is_primary DESC`,
        )
        .all(contact.id) as Array<{ email: string }>

      const allEmails: string[] = emailRows.map((r) => r.email)
      if (contact.email && !allEmails.includes(contact.email)) {
        allEmails.push(contact.email)
      }

      const hasDomainMatch = allEmails.some(
        (email) => extractDomainFromEmail(email) === company.domain,
      )

      if (!hasDomainMatch) {
        clearPrimaryCompany.run(contact.id)
        removeJunctionRow.run(company.id, contact.id)
        totalRemoved += 1
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(`[migration-060] Removed ${totalRemoved} mis-associated contact-company links`)
  }
}
