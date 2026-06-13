import { eq, and } from 'drizzle-orm'
import { getDb } from './db'
import { appConfig } from '../drizzle/schema'
import { WEB_CHAT_DEFAULT_MODEL, WEB_CHAT_MODEL_CONFIG_KEY } from './models'

/**
 * Resolve the Claude model a web-chat surface should use, live and per-firm.
 *
 *   firmId === null  ─►  WEB_CHAT_DEFAULT_MODEL          (no firm to scope to)
 *   firmId set       ─►  app_config[firmId,'webChatModel'].value
 *                          └─ missing row ─► WEB_CHAT_DEFAULT_MODEL
 *
 * Reads the config every request so a change in desktop Settings takes effect on
 * existing shares without re-sharing (the model is NOT frozen onto the share row).
 */
export async function getWebChatModel(firmId: string | null): Promise<string> {
  if (!firmId) return WEB_CHAT_DEFAULT_MODEL

  const rows = await getDb()
    .select({ value: appConfig.value })
    .from(appConfig)
    .where(and(eq(appConfig.firmId, firmId), eq(appConfig.key, WEB_CHAT_MODEL_CONFIG_KEY)))
    .limit(1)

  return rows[0]?.value ?? WEB_CHAT_DEFAULT_MODEL
}
