import { describe, expect, it } from 'vitest'
import { decideSummaryDisplay } from '../summary-display'

// Three terminal states — exhaustive coverage of the (status, summary) grid
// per the SummarySection rendering rules.

describe('decideSummaryDisplay', () => {
  it.each(['transcribing', 'recording'])(
    'transcribing-wait when status=%s, regardless of summary value',
    (status) => {
      expect(decideSummaryDisplay({ status, summary: null })).toEqual({
        kind: 'transcribing-wait',
      })
      expect(decideSummaryDisplay({ status, summary: 'partial summary' })).toEqual({
        kind: 'transcribing-wait',
      })
    },
  )

  it.each(['transcribed', 'summarized', 'empty', 'error'])(
    'empty when status=%s and summary is null',
    (status) => {
      expect(decideSummaryDisplay({ status, summary: null })).toEqual({ kind: 'empty' })
    },
  )

  it('empty when summary is the empty string', () => {
    expect(decideSummaryDisplay({ status: 'transcribed', summary: '' })).toEqual({
      kind: 'empty',
    })
  })

  it('empty when summary is whitespace-only (defensive vs null-sentinel rule)', () => {
    expect(decideSummaryDisplay({ status: 'transcribed', summary: '   \n\t  ' })).toEqual({
      kind: 'empty',
    })
  })

  it('renders markdown when summary is present', () => {
    const md = '# Recap\n\n- Decided on Q3 launch'
    expect(decideSummaryDisplay({ status: 'transcribed', summary: md })).toEqual({
      kind: 'render',
      markdown: md,
    })
  })

  it('renders even on unfamiliar status strings as long as summary is present', () => {
    // Defensive: gateway adds new status values over time. As long as we have
    // a non-empty summary, default to rendering rather than gating on a
    // status whitelist.
    expect(
      decideSummaryDisplay({ status: 'newly-coined-status', summary: 'body' }),
    ).toEqual({ kind: 'render', markdown: 'body' })
  })
})
