import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'

/**
 * Resolve a per-user model id from `user_preferences`, synced up from the
 * desktop Settings dropdowns (USER_PREF_SET → outbox → Neon). Mirrors
 * resolveAnthropicKey()'s shape so model-consuming routes (chat, meeting
 * enhancement) read the user's choice without threading settings through.
 *
 *   user_preferences[userId, key].value  ?? fallback
 *
 * No allow-list validation here: the desktop dropdown only emits known ids, and
 * an unknown value surfaces as a clean Anthropic 4xx via toGatewayErrorIfAnthropic
 * rather than silently masking the user's (mis)configuration.
 */
export async function resolveUserModel(
  env: GatewayEnv,
  userId: string,
  key: string,
  fallback: string,
): Promise<string> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const rows = await db
    .select({ value: schema.userPreferences.value })
    .from(schema.userPreferences)
    .where(
      and(
        eq(schema.userPreferences.userId, userId),
        eq(schema.userPreferences.key, key),
      ),
    )
    .limit(1)
  const value = rows[0]?.value?.trim()
  return value ? value : fallback
}
