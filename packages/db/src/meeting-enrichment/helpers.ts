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

// ════════════════════════════════════════════════════════════════════════════
// PR1b — pure helpers for the meeting-enrichment WRITE PLANNER (plan.ts)
//
// Lifted verbatim (behaviour-preserving) from the desktop so the planner runs
// identically on desktop (SQLite/withSync barrel) and gateway (Drizzle/Neon).
// Sources:
//   packages/db/src/sqlite/repositories/contact-utils.ts  (email/name/candidate)
//   packages/db/src/sqlite/repositories/contact.repo.ts    (notification regex)
//   packages/db/src/sqlite/repositories/meeting.repo.ts     (company normalize/domain)
//   src/main/utils/email-parser.ts                          (normalizeDomain)
//   src/main/utils/company-extractor.ts                     (seed company names)
// This is a BOUNDED duplication window: PR2 converges the desktop onto these and
// removes the originals. The regression-lock tests in enrichment-plan.test.ts
// assert these copies stay byte-identical in behaviour to the originals until then.
// ════════════════════════════════════════════════════════════════════════════

// ── email + name normalization (from contact-utils.ts) ──────────────────────

/** A de-duplicated attendee turned into a prospective contact. */
export interface CandidateContact {
  email: string
  fullName: string
  normalizedName: string
  explicitName: boolean
}

/** Trim/lowercase an email, stripping mailto:/angle-brackets; null if not a valid address. */
export function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^mailto:/, '')
  const cleaned = trimmed.replace(/^<+|>+$/g, '').replace(/[;,]+$/g, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

/** Lowercase + collapse non-alphanumerics to spaces — the contact name match key. */
export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/** Split a full name into first/last (2+ tokens → first = token0, last = rest). */
export function splitFullNameParts(fullName: string): {
  firstName: string | null
  lastName: string | null
} {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length < 2) return { firstName: null, lastName: null }
  return { firstName: tokens[0] || null, lastName: tokens.slice(1).join(' ') || null }
}

/** "jane.doe@x.com" → "Jane Doe"; falls back to the raw email when unsplittable. */
export function inferNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || email
  const words = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  return words.length > 0 ? words.join(' ') : email
}

/** Clean a display name; null for empty/"unknown"/an email masquerading as a name. */
export function sanitizeDisplayName(value: string): string | null {
  const trimmed = value.trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
  if (!trimmed) return null
  if (trimmed.toLowerCase() === 'unknown') return null
  if (normalizeEmail(trimmed)) return null
  return trimmed
}

// ── attendee parsing + candidate merge (from contact-utils.ts) ──────────────

/** Parse one attendee entry ("Jane <j@x>", "Jane (j@x)", "j@x", or a bare name). */
export function parseAttendeeEntry(entry: string): {
  email: string | null
  fullName: string | null
  explicitName: boolean
} {
  const trimmed = entry.trim()
  if (!trimmed) return { email: null, fullName: null, explicitName: false }

  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>$/)
  if (angleMatch) {
    const email = normalizeEmail(angleMatch[2] || '')
    const fullName = sanitizeDisplayName(angleMatch[1] || '')
    return { email, fullName, explicitName: Boolean(fullName) }
  }

  const parenMatch = trimmed.match(/^(.*?)\s*\(([^()]+)\)$/)
  if (parenMatch) {
    const email = normalizeEmail(parenMatch[2] || '')
    const fullName = sanitizeDisplayName(parenMatch[1] || '')
    if (email) return { email, fullName, explicitName: Boolean(fullName) }
  }

  const directEmail = normalizeEmail(trimmed)
  if (directEmail) return { email: directEmail, fullName: null, explicitName: false }

  return { email: null, fullName: sanitizeDisplayName(trimmed), explicitName: true }
}

/** Pick the better of two same-email candidates: explicit name wins, then longer name. */
export function mergeCandidate(
  existing: CandidateContact | undefined,
  incoming: CandidateContact,
): CandidateContact {
  if (!existing) return incoming
  if (incoming.explicitName && !existing.explicitName) return incoming
  if (
    incoming.explicitName === existing.explicitName &&
    incoming.fullName.length > existing.fullName.length
  ) {
    return incoming
  }
  return existing
}

// ── person-name quality scoring (from contact-utils.ts) ─────────────────────

/** Local-part words that are never real people (so an email-derived name is junk). */
export const NAME_STOP_WORDS = new Set([
  'team', 'support', 'info', 'hello', 'noreply', 'no-reply', 'unknown', 'meeting', 'calendar',
])

/** Canonicalize a person-name candidate, or null when it isn't a plausible human name. */
export function normalizePersonNameCandidate(value: string | null | undefined): string | null {
  if (!value) return null
  let candidate = value
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')

  if (!candidate) return null
  if (normalizeEmail(candidate)) return null

  const commaSplit = candidate.match(/^([^,]{2,}),\s*(.{2,})$/)
  if (commaSplit) candidate = `${commaSplit[2]} ${commaSplit[1]}`.trim()

  candidate = candidate
    .replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '')
    .replace(/[^A-Za-z0-9 .,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!candidate) return null
  if (!/[A-Za-z]/.test(candidate)) return null
  if (/\d/.test(candidate)) return null

  const tokens = candidate
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return null
  if (tokens.some((token) => NAME_STOP_WORDS.has(token.toLowerCase()))) return null

  return tokens.join(' ')
}

/** Heuristic quality score for a name (used to decide name upgrades). */
export function nameQualityScore(value: string): number {
  const candidate = normalizePersonNameCandidate(value)
  if (!candidate) return 0

  const tokens = candidate.split(/\s+/)
  let score = 0

  if (tokens.length >= 2) {
    score += 40
    score += Math.min(tokens.length, 4) * 5
  } else {
    score += 8
  }

  if (tokens.every((token) => /^[A-Za-z][A-Za-z.'-]*$/.test(token))) score += 16
  if (tokens.every((token) => token.length >= 2)) score += 12
  if (tokens.length === 1) score -= 25

  score += Math.min(candidate.length, 25)
  return score
}

/** True when a stored name looks auto-derived (single token, or equals the email guess). */
export function isLikelyLowQualityStoredName(
  value: string | null | undefined,
  email: string | null,
): boolean {
  const name = normalizePersonNameCandidate(value)
  if (!name) return true

  const tokens = name.split(/\s+/)
  if (tokens.length < 2) return true

  const normalizedEmail = normalizeEmail(email || '')
  if (normalizedEmail) {
    const inferred = normalizeName(inferNameFromEmail(normalizedEmail))
    if (normalizeName(name) === inferred) return true
  }

  return false
}

// ── notification / bot email filter (from contact.repo.ts) ──────────────────

/** Local-part prefixes that are never real people (calendar systems, bots, bounces). */
export const NOTIFICATION_EMAIL_RE =
  /^(noreply|no-reply|donotreply|do-not-reply|notifications?|mailer-daemon|postmaster|calendar-notification|invitations-noreply|bounce[s]?|automailer|automated?)@/i

export function isNotificationEmail(email: string): boolean {
  return NOTIFICATION_EMAIL_RE.test(email)
}

// ── company normalization + registrable domain (meeting.repo.ts / email-parser.ts) ──

const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu'])

/** Strip protocol/path, lowercase, drop leading www.; null for a bare token (no dot). */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  const noProto = trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!noProto) return null
  const cleaned = noProto.replace(/^www\./, '')
  if (!cleaned) return null
  if (!cleaned.includes('.')) return null
  return cleaned
}

/** Company-name match key: lowercase, non-alphanumerics → single spaces. */
export function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/** "mail.eng.acme.co.uk" → "acme.co.uk"; collapses a domain to its registrable root. */
export function getRegistrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  const tld = labels[labels.length - 1]
  const secondLevel = labels[labels.length - 2]
  if (tld.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLevel) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

/** All forms of a domain to probe against stored primary_domain / domain aliases. */
export function getDomainLookupCandidates(domain: string): string[] {
  const normalized = normalizeDomain(domain)
  if (!normalized) return []
  const registrable = getRegistrableDomain(normalized)
  return [...new Set([normalized, registrable, `www.${registrable}`])]
}

/** "j@mail.acme.com" → "mail.acme.com" (normalized); null when not a bare address. */
export function extractEmailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  const match = normalized.match(/^[^@\s]+@([^@\s]+)$/)
  if (!match?.[1]) return null
  return normalizeDomain(match[1])
}

// ── seed company names from attendees (from company-extractor.ts) ───────────

/** First domain label → humanized name, skipping free providers. "@redswanventures.com" → "Red Swan Ventures". */
function extractCompanyFromEmail(email: string): string | null {
  const match = email.match(/@([^.]+)\./i)
  if (!match) return null
  const domain = match[1].toLowerCase()
  if (COMMON_PROVIDERS.has(domain)) return null
  return humanizeDomainName(domain)
}

/**
 * Derive the meeting's seed company names from attendees, mirroring the desktop
 * caller (`meeting.ipc.ts` / `RecordingSession.ts`): prefer the explicit
 * attendeeEmails list; fall back to email-shaped entries in `attendees`. Deduped,
 * insertion-ordered. Used only when the caller doesn't supply `opts.companies`.
 */
export function deriveSeedCompanyNames(
  attendees: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined,
): string[] {
  const source = attendeeEmails
    ? attendeeEmails
    : (attendees || []).filter((a) => a.includes('@'))
  const companies = new Set<string>()
  for (const entry of source) {
    const company = extractCompanyFromEmail(entry)
    if (company) companies.add(company)
  }
  return [...companies]
}
