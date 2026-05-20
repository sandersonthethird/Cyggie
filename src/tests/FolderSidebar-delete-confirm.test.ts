/**
 * Tests for the cascading-delete confirm prompt logic in FolderSidebar.
 *
 * The repo's `deleteFolder` has always removed nested subfolders via the
 * `OR path GLOB ?` clause, but the confirm dialog only mentioned notes
 * being moved to Inbox — silently destroying nested folders. The fix
 * counts every descendant via `countDescendants` and rewords the prompt
 * to warn when subfolders will be removed.
 *
 * `countDescendants` is the pure helper that drives the new copy; this
 * test pins its tree-walk + the off-by-one assumptions in the message.
 */
import { describe, it, expect } from 'vitest'
import { countDescendants, buildFolderTree } from '../renderer/components/notes/FolderSidebar'

describe('countDescendants', () => {
  it('returns 0 for a leaf folder', () => {
    const [root] = buildFolderTree(['Work'])
    expect(countDescendants(root)).toBe(0)
  })

  it('counts a single direct child', () => {
    const [root] = buildFolderTree(['Work', 'Work/Q1'])
    expect(root.name).toBe('Work')
    expect(countDescendants(root)).toBe(1)
  })

  it('counts multiple direct children', () => {
    const [root] = buildFolderTree(['Work', 'Work/Q1', 'Work/Q2', 'Work/Q3'])
    expect(countDescendants(root)).toBe(3)
  })

  it('counts grandchildren (deep tree)', () => {
    // Work / Q1 / Jan
    //      / Q2
    const [root] = buildFolderTree(['Work', 'Work/Q1', 'Work/Q1/Jan', 'Work/Q2'])
    expect(countDescendants(root)).toBe(3)
  })

  it('does not include the root in its own count', () => {
    const [root] = buildFolderTree(['Work', 'Work/Q1'])
    // 1 child total — root itself is excluded by definition
    expect(countDescendants(root)).toBe(1)
  })

  it('handles a wide+deep tree (4 descendants under one root)', () => {
    // Work
    // ├── Q1
    // │   ├── Jan
    // │   └── Feb
    // └── Q2
    const [root] = buildFolderTree([
      'Work', 'Work/Q1', 'Work/Q1/Jan', 'Work/Q1/Feb', 'Work/Q2',
    ])
    expect(countDescendants(root)).toBe(4)
  })

  it('siblings under different roots are unaffected', () => {
    const tree = buildFolderTree(['Work', 'Work/Q1', 'Personal', 'Personal/Read'])
    const work = tree.find((n) => n.name === 'Work')!
    const personal = tree.find((n) => n.name === 'Personal')!
    expect(countDescendants(work)).toBe(1)
    expect(countDescendants(personal)).toBe(1)
  })
})

describe('delete-confirm message composition', () => {
  // Mirror the inline ternary in FolderSidebar's handleDelete. Kept in
  // sync with that component — if the wording changes there, update here.
  function buildConfirmMessage(fullPath: string, descendantCount: number): string {
    return descendantCount > 0
      ? `Delete folder "${fullPath}" and ${descendantCount} nested subfolder${descendantCount === 1 ? '' : 's'}? Notes inside (including in subfolders) will be moved to Inbox.`
      : `Delete folder "${fullPath}"? Notes inside will be moved to Inbox.`
  }

  it('leaf folder: no subfolder mention', () => {
    expect(buildConfirmMessage('Skills', 0))
      .toBe('Delete folder "Skills"? Notes inside will be moved to Inbox.')
  })

  it('one subfolder: singular wording', () => {
    expect(buildConfirmMessage('Work', 1))
      .toBe('Delete folder "Work" and 1 nested subfolder? Notes inside (including in subfolders) will be moved to Inbox.')
  })

  it('multiple subfolders: plural wording', () => {
    expect(buildConfirmMessage('Work', 4))
      .toBe('Delete folder "Work" and 4 nested subfolders? Notes inside (including in subfolders) will be moved to Inbox.')
  })
})
