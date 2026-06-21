// Ownership logic for firm-shared notes on the desktop.
//
// The desktop pulls a teammate's tagged, non-private notes read-only (gateway
// /sync/pull applies noteVisibilityFilter). A pulled note carries the owner in
// created_by_user_id, so a note is "foreign" (read-only) when that owner isn't
// the current user. Notes created locally before the owner was tracked have a
// null creator → treated as own (editable).
//
// Pure + currentUserId-injected so it's unit-testable without the IPC/electron
// shell; the notes IPC layer passes getCurrentUserId() at the call site.

/** True when `note` is owned by a teammate rather than the current user. */
export function isForeignNote(
  note: { createdByUserId: string | null },
  currentUserId: string | null,
): boolean {
  return note.createdByUserId != null && note.createdByUserId !== currentUserId
}

/** Return a copy of `note` with the transient `readOnly` flag the renderer uses. */
export function stampReadOnly<T extends { createdByUserId: string | null }>(
  note: T,
  currentUserId: string | null,
): T {
  return { ...note, readOnly: isForeignNote(note, currentUserId) }
}
