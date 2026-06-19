// Guarded passthrough for the detail endpoints.
//
// Drizzle hands us the full org_companies / contacts row. We expose it minus an
// internal denylist (explicit keys + a defense-in-depth pattern deny), so new
// business columns reach mobile automatically without editing this file — while
// internal/audit/sync columns can never leak. JSONB list columns are normalized
// to string[]. The route's `.passthrough()` schema is what lets the surviving
// keys serialize; this denylist is the security gate in front of it.
//
//   full row ──▶ drop denylisted + pattern-matched keys ──▶ normalize JSONB ──▶ out
//
// Mirror the `withSync`/MCP discipline in CLAUDE.md: ADD business columns freely;
// to hide a column, add it here.

/** Defense in depth: kill internal columns by shape even if a new one is added
 *  before someone denylists it explicitly. None of these match business fields. */
const PATTERN_DENY: readonly RegExp[] = [
  /lamport/i, // lamport, fieldLamports
  /^firmId$/,
  /ByUserId$/, // createdByUserId, updatedByUserId, deletedByUserId
  /^deleted/i, // deletedAt, deletedByUserId
  /^crm.*Id$/i, // crmCompanyId, crmContactId
  /^normalizedName$/,
  /^classification/i, // classificationSource, classificationConfidence
  /^includeIn/i, // includeInCompaniesView
  /^field(Sources|Lamports)$/,
]

const COMPANY_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'userId',
  'canonicalName', // exposed as `name`
  'createdAt',
  'updatedAt',
  'crmProvider',
  'leadInvestorCompanyId', // internal FK; we expose `leadInvestor` (text)
  'sourceEntityId',
  'sourceEntityType',
])

const CONTACT_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'userId',
  'createdAt',
  'updatedAt',
  'crmProvider',
  // Heavy JSONB the card never renders (decision 2A) — trims payload + exposure.
  'workHistory',
  'educationHistory',
  'linkedinSkills',
  'linkedinEnrichedAt',
  'otherSocials',
])

/** Contact JSONB columns rendered as joined lists → normalize to string[]. */
const CONTACT_LIST_JSONB: readonly string[] = [
  'tags',
  'previousCompanies',
  'investmentStageFocus',
  'investmentSectorFocus',
  'proudPortfolioCompanies',
]

/** JSONB → string[] of display names. Defensive: non-array ⇒ null; never throws. */
export function toStringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const el of v) {
    let s: unknown
    if (typeof el === 'string') s = el
    else if (el && typeof el === 'object') {
      const o = el as Record<string, unknown>
      s = o['name'] ?? o['label'] ?? o['value']
    }
    if (typeof s === 'string' && s.trim().length > 0) out.push(s.trim())
  }
  return out.length ? out : null
}

function isInternal(key: string, explicit: ReadonlySet<string>): boolean {
  return explicit.has(key) || PATTERN_DENY.some((re) => re.test(key))
}

function dropInternal(
  row: Record<string, unknown>,
  explicit: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!isInternal(k, explicit)) out[k] = v
  }
  return out
}

export function sanitizeCompanyRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = dropInternal(row, COMPANY_INTERNAL_KEYS)
  out['name'] = row['canonicalName'] ?? null
  return out
}

export function sanitizeContactRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = dropInternal(row, CONTACT_INTERNAL_KEYS)
  for (const k of CONTACT_LIST_JSONB) out[k] = toStringList(row[k])
  return out
}
