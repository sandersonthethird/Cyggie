// =============================================================================
// diff-notes.ts — word-level diff for the notes conflict modal.
//
// Wraps the `diff` npm package (plan-eng-review 3A — use existing library,
// don't write a diff algo). Output is a flat array of segments tagged
// added / removed / unchanged so the modal can color them inline.
// =============================================================================

import { diffWords } from 'diff'

export interface DiffSegment {
  /** 'added' = present in `next` but not `prev`. 'removed' = the reverse.
   *  'unchanged' = identical in both. */
  kind: 'added' | 'removed' | 'unchanged'
  text: string
}

/**
 * Word-level diff between two note bodies. Used by the conflict modal
 * (mobile/components/NotesConflictModal.tsx) to highlight what differs
 * between "yours" and "theirs".
 *
 * Whitespace-sensitive (diffWords preserves adjacent spaces); we only
 * normalize null → empty so callers don't need to pre-coerce.
 */
export function diffNotes(prev: string | null, next: string | null): DiffSegment[] {
  const a = prev ?? ''
  const b = next ?? ''
  if (a === b) {
    return a.length > 0 ? [{ kind: 'unchanged', text: a }] : []
  }
  const parts = diffWords(a, b)
  const out: DiffSegment[] = []
  for (const p of parts) {
    if (!p.value) continue
    out.push({
      kind: p.added ? 'added' : p.removed ? 'removed' : 'unchanged',
      text: p.value,
    })
  }
  return out
}
