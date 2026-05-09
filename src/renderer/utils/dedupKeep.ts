import type { CompanyDuplicateGroup } from '../../shared/types/company'

/**
 * Resolve which company id should be the "keeper" for a dedup group.
 *
 * Used by every site that needs to know the kept company:
 *   1. The keep dropdown's displayed value (Companies.tsx row render)
 *   2. The bulk apply payload (applyDedupActions)
 *   3. The Review button's modal target (per-row conflict review)
 *   4. The conflict-count effect (which pairs to preview)
 *
 * Resolution rules (matching the UI's existing fallback):
 *   - If the user-stored preference is in the selected set → use it.
 *   - Else if anything is selected → use the first selected id.
 *   - Else → fall back to the group's suggestedKeepCompanyId (typically when
 *     no checkboxes have been ticked yet).
 *
 * Keeping all four sites in lock-step is what prevents the "Review (N
 * conflicts)" button from disagreeing with the modal that opens — they have
 * to preview the same keeper-vs-source pair to agree on the conflict count.
 */
export function resolveDedupKeep(
  group: CompanyDuplicateGroup,
  selectedIds: string[],
  keepPreference: string | undefined
): string {
  if (keepPreference && selectedIds.includes(keepPreference)) {
    return keepPreference
  }
  return selectedIds[0] ?? group.suggestedKeepCompanyId
}
