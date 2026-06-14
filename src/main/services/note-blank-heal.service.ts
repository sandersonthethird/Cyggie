// note-blank-heal.service.ts — re-push the real desktop content of notes the
// pull-side reconcile refused (corrupted blanks on Neon, content on desktop).
//
// THE HEAL (companion to reconcileBlankNote in sync-remote-apply.ts)
// A partial privacy-backfill `op='update'` reached Neon before a note's full
// row existed there, blank-INSERTing it (title NULL, content ''). The desktop
// still holds the real content under the same id at an equal lamport. The pull
// reconcile refuses the blank (so it can't wipe desktop) and hands the id here;
// we re-push the local content so Neon's blank is overwritten and mobile shows
// the real note.
//
// WHY THE BARREL: routing through `updateNote` makes withSync mint a fresh
// (higher) lamport and emit a FULL-row outbox entry. `notes` declares no
// `largeColumns` (owned-tables.ts), so nothing is trimmed — `content` is
// carried — and the gateway stamps the new high lamport on the Neon row, so the
// re-push wins LWW over the blank. A bulk raw UPDATE would bypass the outbox and
// never reach Neon.
//
// Per-note isolation: one failed re-push can't abort the rest; callers log the
// {repushed, failed} counts as the `sync.note.heal` metric and leave the
// one-time repull flag UNSET while failed > 0 so it retries next launch.

import { getNote, updateNote } from '@cyggie/db/sqlite/repositories'

export function repushBlankHealedNotes(ids: string[]): { repushed: number; failed: number } {
  let repushed = 0
  let failed = 0
  for (const id of ids) {
    try {
      const note = getNote(id)
      if (!note) continue // gone locally — nothing to re-push
      // No-op content re-write: same value, but a non-empty SET clause makes
      // withSync mint a new lamport and emit the full row, overwriting the blank.
      // userId=null so we don't rewrite updated_by_user_id.
      updateNote(id, { content: note.content }, null)
      repushed++
    } catch (err) {
      failed++
      console.error(`[note-blank-heal] re-push failed for note ${id}:`, err)
    }
  }
  if (ids.length > 0) {
    console.log(
      `[note-blank-heal] repushed=${repushed} failed=${failed} of ${ids.length} ` +
        'metric=sync.note.heal',
    )
  }
  return { repushed, failed }
}
