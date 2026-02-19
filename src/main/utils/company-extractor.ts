const COMMON_PROVIDERS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol',
  'protonmail', 'me', 'live', 'msn', 'zoho', 'fastmail',
  'hey', 'tutanota', 'gmx', 'pm', 'ymail', 'mail'
])

// Words commonly found in company domain names, used for word segmentation
const DOMAIN_WORDS = new Set([
  // Business suffixes
  'ventures', 'venture', 'capital', 'partners', 'partner', 'labs', 'lab',
  'technologies', 'technology', 'tech', 'solutions', 'digital', 'media',
  'group', 'global', 'studio', 'studios', 'design', 'agency', 'consulting',
  'software', 'systems', 'system', 'network', 'networks', 'health',
  'financial', 'finance', 'works', 'craft', 'games', 'energy', 'analytics',
  'data', 'cloud', 'security', 'industries', 'industry', 'international',
  'research', 'services', 'service', 'investments', 'investment', 'holdings',
  'management', 'advisors', 'advisory', 'creative', 'interactive', 'robotics',
  'bio', 'pharma', 'medical', 'logistics', 'payments', 'hub', 'hq',
  'apps', 'app', 'dev', 'ops', 'platform',
  // Common descriptive words in company names
  'red', 'blue', 'green', 'black', 'white', 'gold', 'silver', 'bright',
  'sky', 'sun', 'moon', 'star', 'fire', 'ice', 'iron', 'steel',
  'swift', 'fast', 'smart', 'next', 'new', 'open', 'true', 'pure',
  'deep', 'high', 'top', 'big', 'one', 'all', 'pro', 'super', 'ever',
  'meta', 'neo', 'alpha', 'beta', 'omega', 'nova', 'apex', 'prime',
  // Animals
  'swan', 'eagle', 'hawk', 'fox', 'bear', 'lion', 'wolf', 'tiger',
  'bird', 'owl', 'bee', 'ant', 'bat', 'elk',
  // Nature / places
  'point', 'peak', 'path', 'way', 'bay', 'lake', 'ridge', 'rock',
  'stone', 'bridge', 'gate', 'tower', 'house', 'base', 'space',
  'nest', 'hive', 'forge', 'mint', 'vine', 'leaf', 'tree', 'seed',
  'root', 'spring', 'wave', 'flow', 'stream', 'light', 'spark',
  'pulse', 'core', 'edge', 'side', 'mind', 'field', 'land',
  // Other
  'ideas', 'idea', 'market', 'box', 'bit', 'byte', 'link', 'grid',
  'wire', 'line', 'signal', 'vision', 'quest', 'shift', 'scale',
  'stack', 'fleet', 'fleet', 'port', 'dock', 'well', 'north', 'south',
  'east', 'west', 'front', 'back'
])

/**
 * Try to segment a concatenated string into known words using backtracking.
 * Returns the words array if the ENTIRE string can be segmented, null otherwise.
 */
function trySegment(str: string, start: number): string[] | null {
  if (start === str.length) return []
  // Try longest match first for better results
  for (let len = Math.min(str.length - start, 15); len >= 2; len--) {
    const word = str.slice(start, start + len)
    if (DOMAIN_WORDS.has(word)) {
      const rest = trySegment(str, start + len)
      if (rest !== null) return [word, ...rest]
    }
  }
  return null
}

/**
 * Convert a raw domain name part to a human-readable name.
 * Splits hyphens/underscores, then tries word segmentation on concatenated parts.
 */
export function humanizeDomainName(name: string): string {
  // Split on hyphens and underscores first
  const parts = name.replace(/[-_]/g, ' ').split(' ')

  const result = parts.map((part) => {
    if (part.length <= 2) return part
    const segments = trySegment(part.toLowerCase(), 0)
    return segments && segments.length > 1 ? segments.join(' ') : part
  }).join(' ')

  // Title-case each word
  return result.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function extractCompanyFromEmail(email: string): string | null {
  const match = email.match(/@([^.]+)\./i)
  if (!match) return null
  const domain = match[1].toLowerCase()
  if (COMMON_PROVIDERS.has(domain)) return null
  return humanizeDomainName(domain)
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
