// =============================================================================
// pg-errors.ts — robust Postgres error classification.
//
// drizzle-orm (0.45+) wraps the underlying node-postgres error in a
// `DrizzleQueryError`, so the SQLSTATE code lives on `err.cause.code`, NOT
// `err.code`. Code that only checks the top-level `.code` silently fails to
// recognize unique-violations and rethrows them as 500s. Always classify via
// this helper.
// =============================================================================

/** True when `err` (or its wrapped cause) is a Postgres unique_violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === '23505'
}

/** Extract the Postgres SQLSTATE code from a raw or drizzle-wrapped error. */
export function pgCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const top = (err as { code?: unknown }).code
  if (typeof top === 'string') return top
  const cause = (err as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = (cause as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return undefined
}
