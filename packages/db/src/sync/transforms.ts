// Column transformation primitives — SQLite → Postgres value coercions.
// Idempotent: each transform handles its own null/empty cases.

/**
 * SQLite stores datetimes as ISO TEXT ('YYYY-MM-DD HH:MM:SS' or full ISO).
 * Some columns store ms-since-epoch as INTEGER. This handles both shapes.
 * Returns null for null/empty input, or unparseable strings.
 */
export function parseSqliteTimestamp(value: unknown): Date | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    // Heuristic: post-2001 timestamps in ms; pre that, assume seconds
    return new Date(value > 1e12 ? value : value * 1000)
  }
  if (typeof value === 'string') {
    // SQLite "YYYY-MM-DD HH:MM:SS" — append Z to disambiguate as UTC
    const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
    const parsed = new Date(normalized)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed
  }
  return null
}

/**
 * SQLite stores booleans as INTEGER (0 / 1). Passes through real booleans
 * unchanged. Returns null only if value is null/undefined.
 */
export function parseSqliteBoolean(value: unknown): boolean | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === '1' || value === 'true'
  return false
}

/**
 * SQLite stores JSON in TEXT columns. Parses to JS value (object/array/primitive).
 * On parse failure, returns the fallback (default null) and logs a warning —
 * we don't want one bad row to fail an entire table migration.
 */
export function parseSqliteJson<T = unknown>(
  value: unknown,
  fallback: T | null = null,
  context?: string,
): T | null {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value as T // already parsed
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[migrate] JSON parse failed${context ? ' in ' + context : ''}: ${msg}; raw=${value.slice(0, 80)}`)
    return fallback
  }
}

/**
 * Pass-through for text columns — coerces null/undefined/empty-string consistently.
 * Returns null for empty strings (Postgres distinguishes '' from NULL; we treat
 * empty as null per consolidated schema convention for most text fields).
 */
export function nullableText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') return String(value)
  return value === '' ? null : value
}

/**
 * Like nullableText but preserves empty strings (for fields where '' has
 * semantic meaning, eg notes.content defaults to '' in the schema).
 */
export function preserveText(value: unknown): string {
  if (value == null) return ''
  if (typeof value !== 'string') return String(value)
  return value
}

/**
 * SQLite REAL → Postgres double precision. Passes numbers through, parses
 * strings, returns null on garbage.
 */
export function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * SQLite INTEGER → Postgres integer. Forces to safe integer; returns null on garbage.
 */
export function nullableInt(value: unknown): number | null {
  const n = nullableNumber(value)
  if (n == null) return null
  return Math.trunc(n)
}

/**
 * Helper for nullable jsonb params. Returns SQL NULL (JS null) when the input is
 * null/undefined/empty, otherwise JSON-serializes for pg. Avoids the trap of
 * `JSON.stringify(null) === '"null"'` which pg would write as JSON-null (a valid
 * JSON value) rather than SQL-NULL (no value).
 */
export function jsonbParam<T>(
  value: unknown,
  context?: string,
): string | null {
  const parsed = parseSqliteJson<T>(value, null, context)
  if (parsed == null) return null
  return JSON.stringify(parsed)
}

/**
 * Like jsonbParam but for jsonb columns with NOT NULL + DEFAULT (e.g. `.default([])`).
 * Returns the fallback's JSON when source is null, never SQL NULL.
 */
export function jsonbParamRequired<T>(
  value: unknown,
  fallback: T,
  context?: string,
): string {
  const parsed = parseSqliteJson<T>(value, fallback, context)
  return JSON.stringify(parsed)
}
