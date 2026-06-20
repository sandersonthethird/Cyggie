import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import type { getDb } from '../db'

// Resolve a user's firm for read-path visibility scoping.
//
// Entry points that already carry a verified JWT (the MCP route, the REST
// routes) get firm_id straight from the token claim and should use THAT — the
// token is the source of truth and avoids a DB round-trip. This helper is for
// the few server-internal callers that hold only a Cyggie userId (the Slack
// handlers, which map a Slack user → a Cyggie user): they look the firm up from
// the users row so the AI/search tools can apply noteVisibilityFilter.
//
// Returns null when the user has no firm (firmless user) → callers fall back to
// owner-only scoping.
export async function resolveFirmId(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<string | null> {
  const row = await db.query.users.findFirst({
    columns: { firmId: true },
    where: eq(schema.users.id, userId),
  })
  return row?.firmId ?? null
}
