/**
 * Shared low-level helpers for parsing SQLite-stored data.
 *
 * These were duplicated in `contact-utils.ts` and `org-company.repo.ts`. They
 * stay tiny + pure — nothing in this module should require database access.
 */

export const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

/**
 * Parse a SQLite-stored timestamp (or any reasonable date string) into an
 * epoch-millisecond number. SQLite's `datetime('now')` format ("YYYY-MM-DD
 * HH:MM:SS[.SSS]") is missing a 'T' separator and a 'Z' suffix — patch both
 * before delegating to `Date.parse`. Returns NaN for nullish / unparseable
 * input.
 */
export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

/**
 * Returns the largest (most recent) timestamp string from a list, or null if
 * every entry is nullish / unparseable. Preserves the original string form
 * (no normalization round-trip).
 */
export function pickLatestTimestamp(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null
  let latestTs = Number.NEGATIVE_INFINITY

  for (const value of values) {
    const ts = parseTimestamp(value)
    if (Number.isNaN(ts)) continue
    if (ts > latestTs) {
      latestTs = ts
      latestValue = value || null
    }
  }

  return latestValue
}

/**
 * Updates `map[key]` only if `candidate` is more recent than the current
 * value. Used to thread a "latest seen" timestamp through fan-out aggregations.
 */
export function setLatestMapValue(
  map: Map<string, string>,
  key: string,
  candidate: string | null | undefined,
): void {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return
  const latest = pickLatestTimestamp([map.get(normalizedKey) || null, candidate])
  if (latest) {
    map.set(normalizedKey, latest)
  }
}

/**
 * Parses a JSON-serialized array of strings stored in a TEXT column. Returns
 * `[]` for any of: nullish input, invalid JSON, non-array JSON, or arrays
 * containing non-string elements (those entries are filtered out).
 */
export function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}
