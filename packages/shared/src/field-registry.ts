// Display contract for the Company / Contact detail "Unified Ledger".
//
// Shared by the mobile generic renderer (PR1) and — in a follow-up (PR3) — the
// desktop FieldSections, so labels/sections/order/format live in ONE place.
// Pure data + pure formatters: NO React, NO node-only deps, so both the Electron
// renderer and the Expo/Metro app can import it.
//
//   detail row ──▶ REGISTRY (ordered, by section) ──▶ formatted rows
//                       │
//                       └─ key not in REGISTRY and not in SKIP_SET
//                          └─▶ MORE section (humanized fallback)  ← drift-proof
//
// Composite "sentinel" keys (hq / website / location / checkSize) are computed
// by the renderer from >1 underlying column; their source columns live in the
// SKIP_SET so they don't also surface in MORE.

export type FieldFormat =
  | 'text' // plain value (optionally humanized)
  | 'currency' // formatCurrency
  | 'number' // String(value)
  | 'months' // `${value} mo`
  | 'date' // formatDateUTC (ISO → "MMM D, YYYY", UTC to avoid off-by-one)
  | 'link' // sky-blue plain text; display label derived by the renderer
  | 'pills' // one or more Pills
  | 'list' // string[] → "a, b, c"

export type PillToneName = 'violet' | 'green' | 'sky' | 'neutral'

export interface FieldMeta {
  /** camelCase detail key, or a sentinel ('hq' | 'website' | 'location' | 'checkSize'). */
  key: string
  label: string
  section: string
  format: FieldFormat
  /** Snake_case enum value → Title Case (e.g. 'pre_seed' → 'Pre Seed'). */
  humanize?: boolean
  /** pills: base tone. */
  tone?: PillToneName
  /** pills: leading status dot. */
  dot?: boolean
  /** pills: split value on comma / "·" into one pill per token. */
  multi?: boolean
}

// ── Company ────────────────────────────────────────────────────────────────
export const COMPANY_FIELD_REGISTRY: readonly FieldMeta[] = [
  // OVERVIEW
  { key: 'industry', label: 'Industry', section: 'OVERVIEW', format: 'pills', tone: 'violet', multi: true },
  { key: 'stage', label: 'Stage', section: 'OVERVIEW', format: 'pills', tone: 'neutral', dot: true, humanize: true },
  { key: 'pipelineStage', label: 'Pipeline', section: 'OVERVIEW', format: 'pills', tone: 'neutral', dot: true, humanize: true },
  { key: 'targetCustomer', label: 'Target customer', section: 'OVERVIEW', format: 'text' },
  { key: 'businessModel', label: 'Business model', section: 'OVERVIEW', format: 'text' },
  { key: 'productStage', label: 'Product stage', section: 'OVERVIEW', format: 'text' },
  { key: 'revenueModel', label: 'Revenue model', section: 'OVERVIEW', format: 'text' },
  { key: 'targetInvestmentStage', label: 'Target investment stage', section: 'OVERVIEW', format: 'text' },
  { key: 'targetInvestmentSector', label: 'Target investment sector', section: 'OVERVIEW', format: 'text' },
  { key: 'employeeCountRange', label: 'Employees', section: 'OVERVIEW', format: 'text' },
  { key: 'foundingYear', label: 'Founded', section: 'OVERVIEW', format: 'number' },
  { key: 'hq', label: 'HQ', section: 'OVERVIEW', format: 'text' }, // sentinel: city, state
  // FINANCIALS
  { key: 'round', label: 'Last round', section: 'FINANCIALS', format: 'text', humanize: true },
  { key: 'raiseSize', label: 'Raise size', section: 'FINANCIALS', format: 'currency' },
  { key: 'postMoneyValuation', label: 'Initial valuation', section: 'FINANCIALS', format: 'currency' },
  { key: 'arr', label: 'ARR', section: 'FINANCIALS', format: 'currency' },
  { key: 'burnRate', label: 'Burn rate', section: 'FINANCIALS', format: 'currency' },
  { key: 'runwayMonths', label: 'Runway', section: 'FINANCIALS', format: 'months' },
  { key: 'lastFundingDate', label: 'Last funded', section: 'FINANCIALS', format: 'date' },
  { key: 'totalFundingRaised', label: 'Total raised', section: 'FINANCIALS', format: 'currency' },
  { key: 'leadInvestor', label: 'Lead investor', section: 'FINANCIALS', format: 'text' },
  // INVESTMENT
  { key: 'portfolioFund', label: 'Portfolio', section: 'INVESTMENT', format: 'text', humanize: true },
  { key: 'investmentSize', label: 'Initial investment', section: 'INVESTMENT', format: 'text' },
  { key: 'ownershipPct', label: 'Initial ownership', section: 'INVESTMENT', format: 'text' },
  { key: 'investmentMark', label: 'Investment mark', section: 'INVESTMENT', format: 'number' },
  { key: 'investmentRound', label: 'Investment round', section: 'INVESTMENT', format: 'text', humanize: true },
  { key: 'initialInvestmentSecurity', label: 'Initial security', section: 'INVESTMENT', format: 'text', humanize: true },
  { key: 'dateOfInitialInvestment', label: 'Date of initial investment', section: 'INVESTMENT', format: 'date' },
  { key: 'initialRoundSize', label: 'Initial round size', section: 'INVESTMENT', format: 'currency' },
  { key: 'lastCompanyValuation', label: 'Last company valuation', section: 'INVESTMENT', format: 'currency' },
  { key: 'followonCheck', label: 'Follow-on check', section: 'INVESTMENT', format: 'currency' },
  { key: 'followonDate', label: 'Follow-on date', section: 'INVESTMENT', format: 'date' },
  { key: 'followonCheck2', label: 'Follow-on check 2', section: 'INVESTMENT', format: 'currency' },
  { key: 'followonDate2', label: 'Follow-on date 2', section: 'INVESTMENT', format: 'date' },
  { key: 'followonInvestmentSize', label: 'Follow-on size', section: 'INVESTMENT', format: 'text' },
  { key: 'totalInvested', label: 'Total investment', section: 'INVESTMENT', format: 'text' },
  // LINKS
  { key: 'website', label: 'Website', section: 'LINKS', format: 'link' }, // sentinel: primaryDomain ?? websiteUrl
  { key: 'linkedinCompanyUrl', label: 'LinkedIn', section: 'LINKS', format: 'link' },
  { key: 'crunchbaseUrl', label: 'Crunchbase', section: 'LINKS', format: 'link' },
  { key: 'angellistUrl', label: 'AngelList', section: 'LINKS', format: 'link' },
  { key: 'twitterHandle', label: 'Twitter', section: 'LINKS', format: 'link' },
]

// ── Contact ──────────────────────────────────────────────────────────────────
export const CONTACT_FIELD_REGISTRY: readonly FieldMeta[] = [
  // ABOUT
  { key: 'title', label: 'Title', section: 'ABOUT', format: 'text' },
  { key: 'primaryCompanyName', label: 'Company', section: 'ABOUT', format: 'text' },
  { key: 'email', label: 'Email', section: 'ABOUT', format: 'text' },
  { key: 'phone', label: 'Phone', section: 'ABOUT', format: 'text' },
  { key: 'linkedinUrl', label: 'LinkedIn', section: 'ABOUT', format: 'link' },
  { key: 'twitterHandle', label: 'Twitter', section: 'ABOUT', format: 'link' },
  { key: 'location', label: 'Location', section: 'ABOUT', format: 'text' }, // sentinel: city, state
  { key: 'street', label: 'Street', section: 'ABOUT', format: 'text' },
  { key: 'postalCode', label: 'Postal Code', section: 'ABOUT', format: 'text' },
  { key: 'country', label: 'Country', section: 'ABOUT', format: 'text' },
  { key: 'timezone', label: 'Timezone', section: 'ABOUT', format: 'text' },
  { key: 'pronouns', label: 'Pronouns', section: 'ABOUT', format: 'text' },
  { key: 'birthday', label: 'Birthday', section: 'ABOUT', format: 'text' },
  { key: 'university', label: 'University', section: 'ABOUT', format: 'text' },
  // RELATIONSHIP
  { key: 'contactType', label: 'Type', section: 'RELATIONSHIP', format: 'pills', tone: 'neutral', humanize: true },
  { key: 'relationshipStrength', label: 'Relationship', section: 'RELATIONSHIP', format: 'pills', tone: 'sky', humanize: true },
  { key: 'talentPipeline', label: 'Talent pipeline', section: 'RELATIONSHIP', format: 'text', humanize: true },
  { key: 'lastMetEvent', label: 'Last met', section: 'RELATIONSHIP', format: 'text' },
  { key: 'warmIntroPath', label: 'Warm intro', section: 'RELATIONSHIP', format: 'text' },
  { key: 'tags', label: 'Tags', section: 'RELATIONSHIP', format: 'list' },
  { key: 'previousCompanies', label: 'Prior companies', section: 'RELATIONSHIP', format: 'list' },
  // INVESTOR
  { key: 'fundSize', label: 'Fund size', section: 'INVESTOR', format: 'currency' },
  { key: 'checkSize', label: 'Check size', section: 'INVESTOR', format: 'text' }, // sentinel: min/max
  { key: 'investmentStageFocus', label: 'Stage focus', section: 'INVESTOR', format: 'list' },
  { key: 'investmentSectorFocus', label: 'Sector focus', section: 'INVESTOR', format: 'list' },
  { key: 'investmentSectorFocusNotes', label: 'Sector notes', section: 'INVESTOR', format: 'text' },
  { key: 'proudPortfolioCompanies', label: 'Portfolio cos', section: 'INVESTOR', format: 'list' },
]

// Keys the card deliberately does NOT auto-render in MORE: rendered elsewhere
// (hero / stats / Key Takeaways / Notes / dedicated segments), sourced by a
// sentinel field above, or intentionally hidden business columns. The gateway
// still EXPOSES these — only the MORE auto-render skips them. (Decision A.)
export const COMPANY_FIELD_SKIP_SET: ReadonlySet<string> = new Set([
  // structural / rendered elsewhere
  'id', 'name', 'description', 'keyTakeaways', 'keyTakeawaysUserNote',
  'lastTouchAt', 'meetingCount', 'status',
  // sentinel sources
  'city', 'state', 'primaryDomain', 'websiteUrl',
  // intentionally hidden business columns
  'entityType', 'priority', 'passedFromStage', 'relationshipOwner', 'dealSource',
  'warmIntroSource', 'nextFollowupDate', 'referralContactId', 'hqAddress',
])

export const CONTACT_FIELD_SKIP_SET: ReadonlySet<string> = new Set([
  // structural / rendered elsewhere
  'id', 'fullName', 'firstName', 'lastName', 'notes', 'keyTakeaways',
  'keyTakeawaysUserNote', 'linkedinHeadline', 'lastTouchAt', 'lastMeetingAt',
  'lastEmailAt', 'primaryCompanyId', 'primaryCompanyDomain',
  // sentinel sources
  'city', 'state', 'typicalCheckSizeMin', 'typicalCheckSizeMax',
])

// ── Pure formatters (framework-agnostic) ─────────────────────────────────────

/** Mirrors src/renderer/utils/format.ts so desktop + mobile agree. */
export function formatCurrency(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`
  return `${sign}$${abs.toLocaleString()}`
}

/** ISO → "MMM D, YYYY" in UTC (date-only columns are midnight-UTC; local TZ
 *  would shift them a day). Returns null for empty / unparseable input. */
export function formatDateUTC(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** snake_case / lower → Title Case ('pre_seed' → 'Pre Seed'). */
export function humanize(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** string[] → "a, b, c"; null/empty → null. */
export function joinList(xs: readonly string[] | null | undefined): string | null {
  if (!xs || xs.length === 0) return null
  const cleaned = xs.map((x) => String(x).trim()).filter(Boolean)
  return cleaned.length ? cleaned.join(', ') : null
}

/** True for values worth rendering: non-empty string, finite number, non-empty array. */
export function isPopulated(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (typeof v === 'number') return !Number.isNaN(v)
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'boolean') return false // booleans aren't ledger rows
  return false
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/

/** Render a scalar value per format. Pills / links / lists / sentinels are
 *  handled by the renderer; this covers text/number/currency/months/date. */
export function formatScalar(value: unknown, format: FieldFormat, humanizeText = false): string | null {
  switch (format) {
    case 'currency':
      return typeof value === 'number' ? formatCurrency(value) : (isPopulated(value) ? String(value) : null)
    case 'number':
      return isPopulated(value) ? String(value) : null
    case 'months':
      return typeof value === 'number' && !Number.isNaN(value) ? `${value} mo` : null
    case 'date':
      return formatDateUTC(typeof value === 'string' ? value : null)
    case 'text':
    default: {
      if (!isPopulated(value)) return null
      const s = String(value)
      return humanizeText ? humanize(s) : s
    }
  }
}

/** MORE fallback: humanize a camelCase key into a label ('investmentMark' → 'Investment mark'). */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Infer a display string for an unknown MORE-section value. */
export function formatUnknown(value: unknown): string | null {
  if (typeof value === 'string') {
    if (!value.trim()) return null
    return ISO_DATE_RE.test(value) ? (formatDateUTC(value) ?? value) : value
  }
  if (typeof value === 'number') return Number.isNaN(value) ? null : String(value)
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) {
    return joinList(value as string[])
  }
  return null // objects / object-arrays (recentMeetings, people) are not MORE rows
}
