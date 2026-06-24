import { describe, it, expect } from 'vitest'
import {
  selectOrphanAttachmentIds,
  ATTACHMENT_GC_GRACE_MS,
} from '../main/services/attachment-gc.service'
import { extractAttachmentRefs } from '@cyggie/db/sqlite/repositories'

// Pure orphan-selection logic for the desktop attachment GC. The DB-touching
// scan/list helpers (collectReferencedAttachmentIds, listOwnActiveAttachmentsForGc)
// are thin SQL and exercised by the sync round-trip integration; the correctness
// the GC must never get wrong — false-orphaning a still-referenced image — lives
// in this pure core.

const NOW = 1_800_000_000_000 // fixed clock (ms)
const OLD = new Date(NOW - 2 * ATTACHMENT_GC_GRACE_MS).toISOString().slice(0, 19).replace('T', ' ')
const FRESH = new Date(NOW - 60_000).toISOString().slice(0, 19).replace('T', ' ')

describe('extractAttachmentRefs', () => {
  it('extracts ids from image and PDF-link markdown', () => {
    const md =
      'Here is an image ![alt](cyggie-attachment://abc123) and a deck ' +
      '[📎 deck.pdf](cyggie-attachment://def456).'
    expect(extractAttachmentRefs(md)).toEqual(['abc123', 'def456'])
  })

  it('returns [] for content with no references / null', () => {
    expect(extractAttachmentRefs('plain note, no attachments')).toEqual([])
    expect(extractAttachmentRefs(null)).toEqual([])
    expect(extractAttachmentRefs(undefined)).toEqual([])
  })
})

describe('selectOrphanAttachmentIds', () => {
  it('selects an unreferenced row older than the grace window', () => {
    const out = selectOrphanAttachmentIds(
      [{ id: 'orphan1', createdAt: OLD }],
      new Set<string>(),
      NOW,
      ATTACHMENT_GC_GRACE_MS,
    )
    expect(out).toEqual(['orphan1'])
  })

  it('FALSE-ORPHAN GUARD: a row still referenced (e.g. only in an OLD memo version) is NOT swept', () => {
    // The reference comes from a historical memo version's markdown — the scan
    // includes ALL versions, so the id lands in `referenced`.
    const oldMemoVersionMarkdown = 'v1 body ![](cyggie-attachment://stillused01) ...'
    const referenced = new Set(extractAttachmentRefs(oldMemoVersionMarkdown))
    const out = selectOrphanAttachmentIds(
      [{ id: 'stillused01', createdAt: OLD }],
      referenced,
      NOW,
      ATTACHMENT_GC_GRACE_MS,
    )
    expect(out).toEqual([])
  })

  it('does NOT sweep a fresh (in-grace) orphan', () => {
    const out = selectOrphanAttachmentIds(
      [{ id: 'fresh1', createdAt: FRESH }],
      new Set<string>(),
      NOW,
      ATTACHMENT_GC_GRACE_MS,
    )
    expect(out).toEqual([])
  })

  it('mixed batch: sweeps only unreferenced + aged rows', () => {
    const out = selectOrphanAttachmentIds(
      [
        { id: 'orphanaged01', createdAt: OLD }, // sweep
        { id: 'refaged01', createdAt: OLD }, // keep (referenced)
        { id: 'orphanfresh01', createdAt: FRESH }, // keep (in grace)
      ],
      new Set(['refaged01']),
      NOW,
      ATTACHMENT_GC_GRACE_MS,
    )
    expect(out).toEqual(['orphanaged01'])
  })

  it('an unparseable timestamp is treated as NOT eligible (fail safe)', () => {
    const out = selectOrphanAttachmentIds(
      [{ id: 'weird', createdAt: 'not-a-date' }],
      new Set<string>(),
      NOW,
      ATTACHMENT_GC_GRACE_MS,
    )
    expect(out).toEqual([])
  })
})
