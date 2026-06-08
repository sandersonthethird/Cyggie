import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'

/**
 * Derives a meeting owner's calendar-side display name from their users
 * row. Used when inserting a meeting on the gateway side (mobile flows,
 * calendar-event provisioning) so the new row gets a non-null
 * `self_name` even when the inbound payload didn't carry one.
 *
 * Fallback chain mirrors migration 0022's backfill: display_name →
 * email → null. (The Postgres users table doesn't carry
 * first_name/last_name — those columns live only on desktop SQLite per
 * migration 033 — so unlike SQLite migration 107 there's no name-parts
 * step here.) Single PK-indexed read.
 */
export async function deriveSelfNameFromUser(
  db: NodePgDatabase<typeof schema>,
  userId: string,
): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: {
      displayName: true,
      email: true,
    },
  })
  if (!user) return null
  const display = user.displayName?.trim()
  if (display) return display
  const email = user.email?.trim()
  if (email) return email
  return null
}
