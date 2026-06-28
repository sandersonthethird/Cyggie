// Ownership logic for firm-shared notes on the desktop.
//
// The desktop pulls a teammate's tagged, non-private notes read-only (gateway
// /sync/pull applies noteVisibilityFilter). A pulled note carries the owner in
// created_by_user_id, so a note is "foreign" (read-only) when that owner isn't
// the current user. Notes created locally before the owner was tracked have a
// null creator → treated as own (editable).
//
// The current user has MORE THAN ONE id: a desktop-local UUID (currentUserId /
// sync_state.user_id) and a gateway cuid2 (the JWT sub). A note that round-trips
// through the gateway comes back stamped with the gateway id, so ownership must
// match against the whole set of the user's identities, not a single id — else
// the user's own round-tripped notes look foreign and lock read-only.
//
// Pure + ids-injected so it's unit-testable without the IPC/electron shell; the
// notes IPC layer passes getMyUserIds() at the call site.

/** True when `note` is owned by a teammate rather than the current user. */
export function isForeignNote(
  note: { createdByUserId: string | null },
  myUserIds: ReadonlyArray<string | null>,
): boolean {
  const owner = note.createdByUserId
  if (owner == null) return false
  return !myUserIds.includes(owner)
}

/** Return a copy of `note` with the transient `readOnly` flag the renderer uses. */
export function stampReadOnly<T extends { createdByUserId: string | null }>(
  note: T,
  myUserIds: ReadonlyArray<string | null>,
): T {
  return { ...note, readOnly: isForeignNote(note, myUserIds) }
}
