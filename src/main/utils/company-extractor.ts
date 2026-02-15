const COMMON_PROVIDERS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol',
  'protonmail', 'me', 'live', 'msn', 'zoho', 'fastmail',
  'hey', 'tutanota', 'gmx', 'pm', 'ymail', 'mail'
])

export function extractCompanyFromEmail(email: string): string | null {
  const match = email.match(/@([^.]+)\./i)
  if (!match) return null
  const domain = match[1].toLowerCase()
  if (COMMON_PROVIDERS.has(domain)) return null
  // Replace hyphens/underscores with spaces, then title-case each word
  return domain
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Extract the full domain from an email address, filtering out common providers.
 * e.g., "caitlin@redswanventures.com" → "redswanventures.com"
 */
export function extractDomainFromEmail(email: string): string | null {
  const match = email.match(/@(.+)$/i)
  if (!match) return null
  const fullDomain = match[1].toLowerCase()
  const firstPart = fullDomain.split('.')[0]
  if (COMMON_PROVIDERS.has(firstPart)) return null
  return fullDomain
}

/**
 * Extract unique domains from a list of emails, filtering out common providers.
 */
export function extractDomainsFromEmails(emails: string[]): string[] {
  const domains = new Set<string>()
  for (const email of emails) {
    const domain = extractDomainFromEmail(email)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

export function extractCompaniesFromEmails(emails: string[]): string[] {
  const companies = new Set<string>()
  for (const email of emails) {
    const company = extractCompanyFromEmail(email)
    if (company) companies.add(company)
  }
  return [...companies]
}

/**
 * Extract companies from an attendees array that may contain
 * a mix of display names and email addresses.
 */
export function extractCompaniesFromAttendees(attendees: string[]): string[] {
  const companies = new Set<string>()
  for (const attendee of attendees) {
    if (attendee.includes('@')) {
      const company = extractCompanyFromEmail(attendee)
      if (company) companies.add(company)
    }
  }
  return [...companies]
}
