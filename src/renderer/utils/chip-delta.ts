/**
 * Compute the new pinnedKeys array after a field drag between sections.
 *
 * Rules:
 *  - Dragging INTO 'summary' section adds chipId to pinnedKeys (idempotent)
 *  - Dragging OUT OF 'summary' section removes chipId from pinnedKeys (idempotent)
 *  - All other moves leave pinnedKeys unchanged
 *
 * @param fromSection  Previous section key (null if unsectioned)
 * @param toSection    Destination section key
 * @param chipId       The chip identifier (e.g. 'custom:abc123' or builtin key)
 * @param currentPinnedKeys  Current value of cyggie:*-summary-fields preference
 */
export function computeChipDelta(
  fromSection: string | null,
  toSection: string,
  chipId: string,
  currentPinnedKeys: string[]
): string[] {
  if (toSection === 'summary') {
    // Add — idempotent
    if (currentPinnedKeys.includes(chipId)) return currentPinnedKeys
    return [...currentPinnedKeys, chipId]
  }
  if (fromSection === 'summary') {
    // Remove — idempotent
    return currentPinnedKeys.filter((k) => k !== chipId)
  }
  return currentPinnedKeys
}
