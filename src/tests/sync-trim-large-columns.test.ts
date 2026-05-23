import { describe, expect, test } from 'vitest'
import { trimUnchangedLargeColumns } from '@cyggie/db/sqlite/repositories/_sync'

// T38 payload trimming — pure-function tests for the diff helper that
// drops unchanged large-JSONB columns from UPDATE outbox payloads. The
// gateway upsert treats missing columns as no-change, so trimming is
// safe and shrinks the wire payload dramatically on common edits
// (title rename, status flip) that don't touch transcriptSegments.

describe('trimUnchangedLargeColumns', () => {
  test('drops unchanged large column', () => {
    const segments = [{ start: 0, end: 1, text: 'hi' }]
    const out = trimUnchangedLargeColumns(
      { id: 'm1', title: 'new', transcriptSegments: segments },
      { id: 'm1', title: 'old', transcriptSegments: segments },
      ['transcriptSegments'],
    )
    expect(out).toEqual({ id: 'm1', title: 'new' })
  })

  test('keeps changed large column', () => {
    const out = trimUnchangedLargeColumns(
      { id: 'm1', transcriptSegments: [{ start: 0, end: 2, text: 'hello' }] },
      { id: 'm1', transcriptSegments: [{ start: 0, end: 1, text: 'hi' }] },
      ['transcriptSegments'],
    )
    expect(out['transcriptSegments']).toEqual([
      { start: 0, end: 2, text: 'hello' },
    ])
  })

  test('handles multiple large columns independently', () => {
    const chat = [{ role: 'user', content: 'q' }]
    const out = trimUnchangedLargeColumns(
      {
        id: 'm1',
        transcriptSegments: [{ start: 0, end: 1, text: 'a' }],
        chatMessages: chat,
        summary: 'changed',
      },
      {
        id: 'm1',
        transcriptSegments: [{ start: 0, end: 1, text: 'b' }],
        chatMessages: chat,
        summary: 'old',
      },
      ['transcriptSegments', 'chatMessages', 'summary'],
    )
    expect(out['transcriptSegments']).toBeDefined() // changed → kept
    expect(out['chatMessages']).toBeUndefined() // unchanged → trimmed
    expect(out['summary']).toBe('changed') // changed → kept
  })

  test('treats null↔non-null as a change', () => {
    const out = trimUnchangedLargeColumns(
      { id: 'm1', transcriptSegments: null },
      { id: 'm1', transcriptSegments: [{ start: 0, end: 1, text: 'x' }] },
      ['transcriptSegments'],
    )
    expect(out['transcriptSegments']).toBeNull()
  })

  test('treats both-null as unchanged → trims', () => {
    const out = trimUnchangedLargeColumns(
      { id: 'm1', transcriptSegments: null },
      { id: 'm1', transcriptSegments: null },
      ['transcriptSegments'],
    )
    expect('transcriptSegments' in out).toBe(false)
  })

  test('keeps column when missing from one side (conservative)', () => {
    // If a key is absent on either side we can't safely diff — keep it.
    const out = trimUnchangedLargeColumns(
      { id: 'm1', transcriptSegments: [{ start: 0, end: 1, text: 'a' }] },
      { id: 'm1' },
      ['transcriptSegments'],
    )
    expect(out['transcriptSegments']).toEqual([{ start: 0, end: 1, text: 'a' }])
  })

  test('does not mutate the input row', () => {
    const row = {
      id: 'm1',
      transcriptSegments: [{ start: 0, end: 1, text: 'a' }],
    }
    const pre = {
      id: 'm1',
      transcriptSegments: [{ start: 0, end: 1, text: 'a' }],
    }
    const out = trimUnchangedLargeColumns(row, pre, ['transcriptSegments'])
    expect(row.transcriptSegments).toBeDefined()
    expect(out['transcriptSegments']).toBeUndefined()
  })

  test('ignores columns not listed in largeColumns', () => {
    // `title` is unchanged but not declared as large → must remain.
    const out = trimUnchangedLargeColumns(
      { id: 'm1', title: 'same', transcriptSegments: 'same-text' },
      { id: 'm1', title: 'same', transcriptSegments: 'same-text' },
      ['transcriptSegments'],
    )
    expect(out['title']).toBe('same')
    expect('transcriptSegments' in out).toBe(false)
  })
})
