// Multi-value detection for CSV import.
//
// A naive `value.split(',')` mis-reads single values that legitimately contain a comma
// — company legal suffixes ("Grow, Inc.") and "City, ST" locations — as multi-item lists,
// which wrongly flags the column "multi-value" and offers a multiselect field. We split on
// commas but treat a trailing legal-entity suffix or US-state abbreviation as part of the
// preceding value rather than a separate item.
//
//   "Grow, Inc."            -> ["Grow, Inc."]            (1 value, not multi)
//   "New York, NY"          -> ["New York, NY"]          (1 value, not multi)
//   "B2B, SaaS, Fintech"    -> ["B2B","SaaS","Fintech"]  (genuine list, multi)
//   "Acme, Inc., Beta, LLC" -> ["Acme, Inc.","Beta, LLC"](list of suffixed names, multi)

const LEGAL_SUFFIXES = new Set([
  'inc', 'inc.', 'llc', 'l.l.c.', 'ltd', 'ltd.', 'co', 'co.', 'corp', 'corp.',
  'lp', 'l.p.', 'llp', 'pllc', 'plc', 'gmbh', 'ag', 'sa', 's.a.', 'nv', 'bv',
  'pty', 'pte', 'srl', 's.r.l.', 'kk', 'oy', 'ab', 'as', 'co.,ltd.',
])

const US_STATES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
  'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
  'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
  'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
])

/** True when a comma-trailing segment belongs to the previous value (suffix / state). */
function isTrailingSuffix(segment: string): boolean {
  const norm = segment.trim().toLowerCase()
  // Note: 'co' overlaps Colorado and "Co." — acceptable; both should attach to the prior value.
  return LEGAL_SUFFIXES.has(norm) || US_STATES.has(norm)
}

/**
 * Split a CSV cell into its real comma-separated values, re-attaching trailing legal
 * suffixes / state abbreviations to the value they belong to. Returns trimmed,
 * non-empty parts.
 */
export function splitMultiValue(value: string): string[] {
  const segments = value.split(',').map((s) => s.trim())
  const parts: string[] = []
  for (const seg of segments) {
    if (!seg) continue
    if (parts.length > 0 && isTrailingSuffix(seg)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${seg}`
    } else {
      parts.push(seg)
    }
  }
  return parts
}

/** True if any sample value is a genuine (suffix-aware) multi-item list. */
export function detectMultiValue(sampleValues: string[]): boolean {
  return sampleValues.some((v) => splitMultiValue(v).length > 1)
}

/** Unique option values across sample data (suffix-aware), capped at 20. */
export function extractOptions(sampleValues: string[]): string[] {
  const seen = new Set<string>()
  for (const v of sampleValues) {
    for (const part of splitMultiValue(v)) seen.add(part)
  }
  return [...seen].slice(0, 20)
}

// ─── Combined "City, State" parsing ───────────────────────────────────────────
//
// Some CSVs put location in one column ("New York, NY"). Cyggie stores city + state
// separately, so when a column is mapped to the combined "City + State" field we split
// on the LAST comma: everything before is the city, the trailing token is the state.
// No comma → whole value is the city.

export function parseCityState(value: string): { city: string; state: string | null } {
  const trimmed = value.trim()
  const idx = trimmed.lastIndexOf(',')
  if (idx === -1) return { city: trimmed, state: null }
  const city = trimmed.slice(0, idx).trim()
  const state = trimmed.slice(idx + 1).trim()
  if (!city || !state) return { city: trimmed, state: null }
  return { city, state }
}
