import type { ContactSummaryUpdateProposal } from '../types/summary'

/**
 * Merge proposals from multiple meetings for the same contact.
 * For each field, keep the first non-null value (most recent meeting first,
 * since summarizedMeetings is sorted date-desc before calling).
 * Handles all built-in, investor, and custom fields generically.
 */
export function mergeContactProposals(proposals: ContactSummaryUpdateProposal[]): ContactSummaryUpdateProposal[] {
  const byContact = new Map<string, ContactSummaryUpdateProposal>()
  for (const p of proposals) {
    const existing = byContact.get(p.contactId)
    if (!existing) {
      byContact.set(p.contactId, {
        ...p,
        changes: [...p.changes],
        updates: { ...p.updates },
        customFieldUpdates: p.customFieldUpdates ? [...p.customFieldUpdates] : undefined,
      })
      continue
    }
    // Merge updates: keep first non-null per key (skip fieldSources — handled separately)
    for (const [key, val] of Object.entries(p.updates)) {
      if (key === 'fieldSources') continue
      if (val != null && (existing.updates as Record<string, unknown>)[key] == null) {
        (existing.updates as Record<string, unknown>)[key] = val
      }
    }
    // Merge changes array (field name dedup)
    for (const change of p.changes) {
      if (!existing.changes.some((c) => c.field === change.field)) {
        existing.changes.push(change)
      }
    }
    // Merge companyLink: first wins
    if (!existing.companyLink && p.companyLink) {
      existing.companyLink = p.companyLink
      if (!existing.changes.some((c) => c.field === 'company')) {
        existing.changes.push({ field: 'company', from: null, to: p.companyLink.companyName })
      }
    }
    // Merge customFieldUpdates (dedup by fieldDefinitionId)
    for (const cfu of (p.customFieldUpdates ?? [])) {
      if (!(existing.customFieldUpdates ?? []).some(e => e.fieldDefinitionId === cfu.fieldDefinitionId)) {
        if (!existing.customFieldUpdates) existing.customFieldUpdates = []
        existing.customFieldUpdates.push(cfu)
      }
    }
    // fieldSources: use latest meeting's sources (last wins)
    if (p.updates.fieldSources) existing.updates.fieldSources = p.updates.fieldSources
  }
  return [...byContact.values()]
}
