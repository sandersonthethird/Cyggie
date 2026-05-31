// Markdown + deep-link helpers for MCP tool output.
//
// Tools return markdown strings optimized for LLM consumption. Numbers
// formatted human-friendly (e.g. "$12.5M Series A (2024-03-15)"), dates
// in ISO short form, missing fields skipped rather than rendered as
// "null"/"undefined".

// Deep-link scheme — matches the existing `cyggie://` scheme used by
// MOBILE_DEEP_LINK_BASE / desktop OAuth callback / firm invites.
// Desktop Electron + iOS Expo both register this scheme.
const CYGGIE_SCHEME = 'cyggie://'

export type CyggieEntityKind = 'company' | 'contact' | 'meeting' | 'note'

export function cyggieUrl(kind: CyggieEntityKind, id: string): string {
  return `${CYGGIE_SCHEME}${kind}/${id}`
}

// "$12.5M" / "$500K" / "$5.0B". Returns null for nullish/zero so callers
// can choose to skip the line entirely (don't render "Total funding: null").
export function formatUSD(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value === 0) return '$0'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

// "2024-03-15". Single representation; tools never render time-of-day.
// Null/invalid input returns null so callers can omit the line.
export function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// Compact relative-time tag for recency ranking — "2 days ago",
// "3 weeks ago", "Jan 2024". Used in candidate lists to help the LLM
// disambiguate ("which Acme? — last met 2 weeks ago vs 18 months ago").
export function formatRecency(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return null
  const now = Date.now()
  const ms = now - d.getTime()
  if (ms < 0) return formatDate(d) // future
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} ago`
}

// Concatenates labeled lines, dropping any with a null/empty value.
// Used to render entity blocks ("Industry: AI", "Stage: Series A", ...)
// without "Industry: null" garbage when fields are missing.
export function labeledLines(pairs: Array<[string, string | null | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

// "$12.5M Series A (2024-03-15) — Acme Ventures lead, with Sequoia, a16z"
// One-liner used inside company blocks. All sub-fields optional; returns
// null when ALL are missing so caller skips the funding line entirely.
export function formatFundingLine(args: {
  totalFundingRaised?: number | null
  round?: string | null
  raiseSize?: number | null
  lastFundingDate?: Date | string | null
  leadInvestor?: string | null
  coInvestors?: unknown // jsonb — string[] in practice
}): string | null {
  const parts: string[] = []
  const sizeStr = formatUSD(args.raiseSize) ?? formatUSD(args.totalFundingRaised)
  if (sizeStr) parts.push(sizeStr)
  if (args.round) parts.push(args.round)
  const dateStr = formatDate(args.lastFundingDate)
  if (dateStr) parts.push(`(${dateStr})`)

  let line = parts.length > 0 ? parts.join(' ') : null

  const investorBits: string[] = []
  if (args.leadInvestor) investorBits.push(`${args.leadInvestor} lead`)
  if (Array.isArray(args.coInvestors) && args.coInvestors.length > 0) {
    const co = args.coInvestors.filter((x): x is string => typeof x === 'string')
    if (co.length > 0) {
      investorBits.push(`with ${co.slice(0, 3).join(', ')}${co.length > 3 ? '…' : ''}`)
    }
  }
  if (investorBits.length > 0) {
    line = (line ? line + ' — ' : '') + investorBits.join(', ')
  }

  return line
}
