const COMMON_PROVIDERS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol',
  'protonmail', 'me', 'live', 'msn', 'zoho', 'fastmail',
  'hey', 'tutanota', 'gmx', 'pm', 'ymail', 'mail'
])

/**
 * Extract the single external company domain from attendee emails.
 * Returns the domain if there's exactly one unique company domain, null otherwise.
 */
export function getSingleCompanyDomain(emails: string[] | null | undefined): string | null {
  if (!emails || emails.length === 0) return null

  const domains = new Set<string>()
  for (const email of emails) {
    const match = email.match(/@(.+)$/i)
    if (!match) continue
    const fullDomain = match[1].toLowerCase()
    const firstPart = fullDomain.split('.')[0]
    if (COMMON_PROVIDERS.has(firstPart)) continue
    domains.add(fullDomain)
  }

  if (domains.size === 1) return [...domains][0]
  return null
}
