import { WEB_SHARE_API_URL, WEB_SHARE_API_SECRET } from '../config/web-share.config'
import { getCurrentFirmId } from '../security/current-firm'
import { getSetting } from '@cyggie/db/sqlite/repositories/settings.repo'

/**
 * Push the firm's web-chat model up to the Next.js web app so the public share
 * chat routes resolve it live (see web/lib/web-config.ts). Fire-and-forget:
 * swallows errors so a transient blip never breaks the desktop settings save —
 * the web side falls back to WEB_CHAT_DEFAULT_MODEL until the next successful
 * push (the launch backfill heals missed pushes).
 *
 * No-ops when the firm_id is unknown (signed out / pre-onboarding) — there's no
 * firm to scope the config to, so the web side keeps using its default.
 */
export async function pushWebChatModel(firmId: string | null, model: string): Promise<void> {
  if (!firmId || !model || !WEB_SHARE_API_SECRET) return
  try {
    await fetch(`${WEB_SHARE_API_URL}/api/web-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WEB_SHARE_API_SECRET}`,
      },
      body: JSON.stringify({ firmId, model }),
    })
  } catch {
    // Best-effort; see doc comment.
  }
}

/**
 * One-time backfill on app launch: push the current `webShareModel` setting so a
 * value chosen before this shipped (or while offline) reaches Neon. Safe to call
 * unconditionally; no-ops when firm_id or the setting is absent.
 */
export async function backfillWebChatModelOnLaunch(): Promise<void> {
  const model = (getSetting('webShareModel') || '').trim()
  if (!model) return
  await pushWebChatModel(getCurrentFirmId(), model)
}
