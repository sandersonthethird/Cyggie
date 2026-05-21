// Unit tests for the `decidePollAction` pure function — the status-mapping
// brain of useTranscribingPoll. Covers all 6 branches (noop / transcribed /
// empty / error-retryable / error-stale / gone) without standing up a React
// renderer or react-query test harness.
//
// poll-action.ts deliberately has zero React-Native imports so vitest can
// load it in the root node runner. 404 detection is duck-typed (matches
// any error with status === 404) rather than `instanceof ApiError` — that
// keeps the api/client import chain out of the test's module graph.

import { describe, expect, it } from 'vitest'
import { decidePollAction, ERROR_RETRYABILITY_WINDOW_MS } from '../poll-action'

const FIXED_NOW = new Date('2026-05-21T12:00:00Z').getTime()

function meeting(overrides: { status: string; updatedAtAgeMs?: number }) {
  return {
    status: overrides.status,
    updatedAt: new Date(
      FIXED_NOW - (overrides.updatedAtAgeMs ?? 0),
    ).toISOString(),
  }
}

describe('decidePollAction', () => {
  it('returns noop when no data and no error (still polling)', () => {
    expect(
      decidePollAction({ data: undefined, error: undefined, nowMs: FIXED_NOW }),
    ).toEqual({ kind: 'noop' })
  })

  it('returns noop when status is still recording/transcribing', () => {
    expect(
      decidePollAction({
        data: meeting({ status: 'transcribing' }),
        error: undefined,
        nowMs: FIXED_NOW,
      }),
    ).toEqual({ kind: 'noop' })
    expect(
      decidePollAction({
        data: meeting({ status: 'recording' }),
        error: undefined,
        nowMs: FIXED_NOW,
      }),
    ).toEqual({ kind: 'noop' })
  })

  it('maps transcribed to terminal-transcribed', () => {
    expect(
      decidePollAction({
        data: meeting({ status: 'transcribed' }),
        error: undefined,
        nowMs: FIXED_NOW,
      }),
    ).toEqual({ kind: 'terminal-transcribed' })
  })

  it('maps empty to terminal-empty (separate from transcribed so detail UI can branch)', () => {
    expect(
      decidePollAction({
        data: meeting({ status: 'empty' }),
        error: undefined,
        nowMs: FIXED_NOW,
      }),
    ).toEqual({ kind: 'terminal-empty' })
  })

  it('maps recent error to error-retryable (5 minutes ago)', () => {
    const out = decidePollAction({
      data: meeting({ status: 'error', updatedAtAgeMs: 5 * 60 * 1000 }),
      error: undefined,
      nowMs: FIXED_NOW,
    })
    expect(out.kind).toBe('error-retryable')
  })

  it('maps stale error to error-stale (60 minutes ago > 30min window)', () => {
    const out = decidePollAction({
      data: meeting({ status: 'error', updatedAtAgeMs: 60 * 60 * 1000 }),
      error: undefined,
      nowMs: FIXED_NOW,
    })
    expect(out.kind).toBe('error-stale')
  })

  it('uses < (strict) at the 30min boundary — exactly-30min is stale', () => {
    const out = decidePollAction({
      data: meeting({ status: 'error', updatedAtAgeMs: ERROR_RETRYABILITY_WINDOW_MS }),
      error: undefined,
      nowMs: FIXED_NOW,
    })
    expect(out.kind).toBe('error-stale')
  })

  it('treats error with malformed updatedAt as retryable (ageMs = 0)', () => {
    // Bias: if we can't parse the timestamp, prefer "retry" over "discard"
    // so a parsing bug doesn't silently throw away the user's recording.
    const out = decidePollAction({
      data: { status: 'error', updatedAt: 'not a real date' },
      error: undefined,
      nowMs: FIXED_NOW,
    })
    expect(out.kind).toBe('error-retryable')
  })

  it('maps 404 error to gone (overrides whatever data is present)', () => {
    // Duck-typed match: any error object with status === 404 counts. Real
    // ApiError instances at runtime expose this same shape, but the pure
    // function avoids the import to keep the test runner happy.
    const out = decidePollAction({
      data: meeting({ status: 'transcribing' }),
      error: { status: 404, code: 'MEETING_NOT_FOUND', message: 'gone' },
      nowMs: FIXED_NOW,
    })
    expect(out.kind).toBe('gone')
  })

  it('ignores non-404 status errors (transient — keep polling)', () => {
    const out = decidePollAction({
      data: undefined,
      error: { status: 500, code: 'INTERNAL', message: 'boom' },
      nowMs: FIXED_NOW,
    })
    expect(out).toEqual({ kind: 'noop' })
  })

  it('ignores plain Error objects (treats them as transient)', () => {
    const out = decidePollAction({
      data: undefined,
      error: new Error('network blip'),
      nowMs: FIXED_NOW,
    })
    expect(out).toEqual({ kind: 'noop' })
  })

  it('ignores null/undefined error correctly', () => {
    expect(
      decidePollAction({ data: undefined, error: null, nowMs: FIXED_NOW }),
    ).toEqual({ kind: 'noop' })
    expect(
      decidePollAction({ data: undefined, error: undefined, nowMs: FIXED_NOW }),
    ).toEqual({ kind: 'noop' })
  })
})
