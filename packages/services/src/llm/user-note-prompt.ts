/**
 * Shared prompt fragments for injecting the user-authored Key Takeaways
 * note into LLM context. Used by contact-key-takeaways and
 * company-key-takeaways so both services treat the user's note the same
 * way: as known truth the model should build on, not restate.
 */

export const USER_NOTE_SYSTEM_RULE =
  `If "USER'S OWN NOTES" appear in the context, treat them as known truth. ` +
  `Elaborate or complement them but do not restate the same points.`

export function userNoteContextBlock(userNote: string | null | undefined): string {
  const trimmed = userNote?.trim()
  if (!trimmed) return ''
  return `\n\nUSER'S OWN NOTES (treat as known truth, do not repeat verbatim):\n${trimmed}`
}
