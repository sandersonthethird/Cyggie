// identity-reconcile.ts — heal the desktop's two-identity split for notes.
//
// Every user has two ids: a desktop-local UUID (currentUserId / sync_state.user_id,
// minted offline-first) and a gateway cuid2 (the JWT sub, minted at OAuth sign-in).
// They're never unified. Because the gateway stamps created_by_user_id from the
// JWT sub, any note that round-trips through it (push → server-side touch → pull)
// comes back owned by the gateway id, and pull-LWW overwrites the local owner.
// Those notes then fail the firm-shared read-only check and lock the user out of
// their own notes (see note-ownership.ts / getMyUserIds).
//
// getMyUserIds() already keeps such notes editable at read time. This module is
// the one-time data clean-up: it rewrites the already mis-stamped rows back to
// the local id so the data is clean and the notes are editable even offline.
//
// Generic, not hardcoded: it keys off getCyggieUserId() — literally the current
// user's own JWT sub — so it's correct for every user. The duplicate `users`
// row carrying the gateway id is deliberately LEFT in place: it's the FK target
// for any future note that round-trips with the gateway id, and the sync-pull
// validator drops rows whose owner is missing from `users`.

import type Database from 'better-sqlite3'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { getCurrentUserId, GATEWAY_ID_SETTING } from './current-user'
import { getCyggieUserId } from '../auth/cyggie-auth-storage'

/** Run-once guard so the rewrite doesn't re-scan the notes table every launch. */
const RECONCILED_FLAG = 'gatewayIdNotesReconciled'

/**
 * If the gateway id is known and differs from the local id, persist it as the
 * durable alias and (once) rewrite any notes still owned by it back to the local
 * id. Best-effort: any failure is swallowed so it never blocks startup/sign-in —
 * getMyUserIds() keeps the notes editable regardless. Safe to call repeatedly.
 */
export function reconcileGatewayIdentity(): void {
  try {
    const gw = getCyggieUserId()
    if (!gw) return // not signed in / id not known yet — nothing to reconcile

    const local = getCurrentUserId()
    if (gw === local) return // already unified — nothing to do

    // Ensure the durable alias is recorded even if storeCyggieTokens predates it.
    if ((settingsRepo.getSetting(GATEWAY_ID_SETTING) || '').trim() !== gw) {
      settingsRepo.setSetting(GATEWAY_ID_SETTING, gw)
    }

    if (settingsRepo.getSetting(RECONCILED_FLAG) === '1') return

    const rewritten = rewriteNoteOwner(getDatabase(), gw, local)
    settingsRepo.setSetting(RECONCILED_FLAG, '1')
    if (rewritten > 0) {
      console.log(
        `[identity-reconcile] rewrote ${rewritten} note owner id(s) gateway→local`,
      )
    }
  } catch (err) {
    console.warn('[identity-reconcile] non-fatal:', err)
  }
}

/**
 * Rewrite notes.{created,updated,deleted}_by_user_id from `gw` → `local`.
 * Local-only on purpose: it does NOT go through the withSync barrel/outbox — the
 * gateway re-stamps `gw` on its side anyway, so pushing the rewrite would just
 * ping-pong. Returns the number of created_by rows changed (the visible count).
 */
export function rewriteNoteOwner(
  db: Database.Database,
  gw: string,
  local: string,
): number {
  const result = db.transaction((): number => {
    const created = db
      .prepare(`UPDATE notes SET created_by_user_id = ? WHERE created_by_user_id = ?`)
      .run(local, gw)
    db.prepare(`UPDATE notes SET updated_by_user_id = ? WHERE updated_by_user_id = ?`).run(
      local,
      gw,
    )
    db.prepare(`UPDATE notes SET deleted_by_user_id = ? WHERE deleted_by_user_id = ?`).run(
      local,
      gw,
    )
    return created.changes
  })()
  return result
}
