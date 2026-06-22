// Pure helpers for meeting-creation enrichment — shared by the desktop
// (SQLite via the withSync barrel) and the gateway (Drizzle/Neon). No I/O, no
// DB, no electron — only string/domain transforms, so the exact same name
// extraction + plausibility logic runs in both contexts.
//
// Lifted verbatim (behaviour-preserving) from the desktop's
//   src/main/utils/company-extractor.ts   (domain → name)
//   src/main/services/company-enrichment.ts (homepage parse + plausibility)
//   src/main/utils/string-utils.ts          (splitCamelCase)
// PR2 converges the desktop onto these and deletes the originals.

// ── splitCamelCase (from string-utils.ts) ───────────────────────────────────
/** "AcmeCorp" → "Acme Corp"; only splits when the input mixes upper+lower. */
export function splitCamelCase(s: string): string {
  if (!s) return s
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
}

// ── domain → human name (from company-extractor.ts) ─────────────────────────
const COMMON_PROVIDERS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'icloud', 'aol',
  'protonmail', 'me', 'live', 'msn', 'zoho', 'fastmail',
  'hey', 'tutanota', 'gmx', 'pm', 'ymail', 'mail',
])

// Words commonly found in company domain names, used for word segmentation.
const DOMAIN_WORDS = new Set([
  'corp', 'inc', 'llc', 'ltd', 'lp',
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
  'red', 'blue', 'green', 'black', 'white', 'gold', 'silver', 'bright',
  'sky', 'sun', 'moon', 'star', 'fire', 'ice', 'iron', 'steel',
  'swift', 'fast', 'smart', 'next', 'new', 'open', 'true', 'pure',
  'deep', 'high', 'top', 'big', 'one', 'all', 'pro', 'super', 'ever',
  'meta', 'neo', 'alpha', 'beta', 'omega', 'nova', 'apex', 'prime',
  'swan', 'eagle', 'hawk', 'fox', 'bear', 'lion', 'wolf', 'tiger',
  'bird', 'owl', 'bee', 'ant', 'bat', 'elk',
  'point', 'peak', 'path', 'way', 'bay', 'lake', 'ridge', 'rock',
  'stone', 'bridge', 'gate', 'tower', 'house', 'base', 'space',
  'nest', 'hive', 'forge', 'mint', 'vine', 'leaf', 'tree', 'seed',
  'root', 'spring', 'wave', 'flow', 'stream', 'light', 'spark',
  'pulse', 'core', 'edge', 'side', 'mind', 'field', 'land',
  'ideas', 'idea', 'market', 'box', 'bit', 'byte', 'link', 'grid',
  'wire', 'line', 'signal', 'vision', 'quest', 'shift', 'scale',
  'stack', 'fleet', 'port', 'dock', 'well', 'north', 'south',
  'east', 'west', 'front', 'back',
])

/**
 * Segment a concatenated string into known DOMAIN_WORDS via backtracking.
 * Returns the words if the ENTIRE string segments, else null.
 */
export function trySegment(str: string, start: number): string[] | null {
  if (start === str.length) return []
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
 * Convert a raw domain part to a human-readable name.
 *   1. CamelCase split  — "AcmeCorp"        → "Acme Corp"
 *   2. DOMAIN_WORDS      — "redswanventures" → "Red Swan Ventures"
 *   3. Unchanged         — "bowley"          → "Bowley"
 */
export function humanizeDomainName(name: string): string {
  const parts = name.replace(/[-_]/g, ' ').split(' ')
  const result = parts
    .map((part) => {
      if (part.length <= 2) return part
      const camelSplit = splitCamelCase(part)
      if (camelSplit !== part) return camelSplit
      const segments = trySegment(part.toLowerCase(), 0)
      return segments && segments.length > 1 ? segments.join(' ') : part
    })
    .join(' ')
  return result.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Last-resort deterministic name from a domain: "caphub.com" → "Cap Hub". */
export function domainToTitleCase(domain: string): string {
  return humanizeDomainName(domain.split('.')[0])
}

/** "caitlin@redswanventures.com" → "redswanventures.com"; null for free providers. */
export function extractDomainFromEmail(email: string): string | null {
  const match = email.match(/@(.+)$/i)
  if (!match) return null
  const fullDomain = match[1].toLowerCase()
  const firstPart = fullDomain.split('.')[0]
  if (COMMON_PROVIDERS.has(firstPart)) return null
  return fullDomain
}

/** Unique non-free-provider domains from a list of emails. */
export function extractDomainsFromEmails(emails: string[]): string[] {
  const domains = new Set<string>()
  for (const email of emails) {
    const domain = extractDomainFromEmail(email)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

// ── homepage HTML → name (from company-enrichment.ts) ───────────────────────
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|–—:·•]\s*.+$/, '')
    .replace(/^(Home|Welcome to)\s*[-–—|:]\s*/i, '')
    .trim()
}

/** Extract a company name from homepage HTML: og:site_name → application-name → <title>. */
export function parseCompanyName(html: string): string | null {
  const ogSiteName =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1]
  if (ogSiteName && ogSiteName.trim().length >= 2) return ogSiteName.trim()

  const appName =
    html.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']application-name["']/i)?.[1]
  if (appName && appName.trim().length >= 2) return appName.trim()

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    const cleaned = cleanTitle(titleMatch[1].trim())
    if (cleaned && cleaned.length >= 2 && cleaned.length <= 60) return cleaned
  }
  return null
}

/**
 * Reject strings that read as a marketing tagline/slogan rather than a company
 * name. High-precision: must not reject real (possibly long) names, only
 * obvious value-prop copy. When in doubt, keep it — the domain heuristic is the
 * upstream safety net.
 */
export function isPlausibleCompanyName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 60) return false
  if (/[.!?]$/.test(trimmed)) return false
  const words = trimmed.split(/\s+/)
  if (words.length > 7) return false
  if (words.length >= 3 && /^[A-Za-z]+ing$/.test(words[0])) return false
  return true
}
