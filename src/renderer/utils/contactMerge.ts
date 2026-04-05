import type { ContactSummary } from '../../shared/types/contact'

/**
 * Returns the ID of the best "keep" candidate from a list of contacts to merge.
 *
 * Selection logic:
 *   1. Highest total engagement (meetingCount + emailCount)
 *   2. Ties broken by first in array
 *
 * This mirrors the completeness heuristic in compareDuplicateCandidates
 * (contact-utils.ts) but operates on ContactSummary instead of
 * ContactDuplicateSummary, using meeting/email counts instead of field counts.
 */
export function selectMergeKeepId(contacts: ContactSummary[]): string {
  if (contacts.length === 0) throw new Error('contacts must be non-empty')
  return contacts.reduce((best, c) =>
    (c.meetingCount + c.emailCount) > (best.meetingCount + best.emailCount) ? c : best
  ).id
}
