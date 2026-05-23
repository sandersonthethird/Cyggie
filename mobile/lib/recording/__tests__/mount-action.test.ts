// Unit tests for `decideMountAction` — the pure decision function that
// encodes the /record cold-start state machine. Covers the full 9-branch
// matrix from mount-action.ts's docstring without standing up a React
// renderer.
//
// Closes critical failure-mode #⑪ from the plan review: 3 user-visible
// bugs in a row tonight came from this 5-branch logic. Exhaustive tests
// here protect against the same regressions returning.

import { describe, expect, it } from 'vitest'
import {
  decideMountAction,
  type MeetingProbeResult,
  type StoreStatus,
} from '../mount-action'
import type { PendingUpload } from '../pending-upload'

function makePending(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    clientRecordingId: 'rec-1',
    userId: 'user-test',
    localUri: 'file:///a.m4a',
    clientRecordedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('decideMountAction', () => {
  // ─── Active-local-work preservation ──────────────────────────────────────
  it.each<StoreStatus>(['recording', 'uploading'])(
    'preserves active local work (storeStatus=%s)',
    (storeStatus) => {
      const action = decideMountAction({ storeStatus, pending: null })
      expect(action).toEqual({ kind: 'preserve' })
    },
  )

  it('preserves active local work even when MMKV has a stale entry', () => {
    const action = decideMountAction({
      storeStatus: 'uploading',
      pending: makePending({ meetingId: 'mtg-old' }),
    })
    expect(action).toEqual({ kind: 'preserve' })
  })

  // ─── Leftover non-idle store state ───────────────────────────────────────
  it.each<StoreStatus>(['transcribing', 'done', 'error'])(
    'resets and starts fresh for leftover %s state (no MMKV)',
    (storeStatus) => {
      const action = decideMountAction({ storeStatus, pending: null })
      expect(action).toEqual({ kind: 'reset-and-start-fresh' })
    },
  )

  it('resets and starts fresh for leftover transcribing, leaving MMKV INTACT (safety net)', () => {
    // This is the user's invariant — local audio file for the older
    // recording must not be deleted when starting a new one. The
    // 'reset-and-start-fresh' action explicitly does NOT carry a
    // clientRecordingId to discard.
    const action = decideMountAction({
      storeStatus: 'transcribing',
      pending: makePending({ meetingId: 'mtg-old' }),
    })
    expect(action).toEqual({ kind: 'reset-and-start-fresh' })
  })

  // ─── Idle + no MMKV ──────────────────────────────────────────────────────
  it('starts fresh when idle with no pending entry', () => {
    const action = decideMountAction({ storeStatus: 'idle', pending: null })
    expect(action).toEqual({ kind: 'start-fresh' })
  })

  // ─── Idle + MMKV without meetingId (awaiting_upload retry) ──────────────
  it('shows retry UI when idle and pending has no meetingId', () => {
    const pending = makePending({ lastError: 'previous attempt failed' })
    const action = decideMountAction({ storeStatus: 'idle', pending })
    expect(action).toEqual({ kind: 'show-retry-ui', pending })
  })

  // ─── Idle + MMKV with meetingId + probe variants ────────────────────────
  it.each<MeetingProbeResult>([{ kind: 'in-flight' }, { kind: 'unknown' }])(
    're-attaches poll for probe=%j (in-flight or unknown stays conservative)',
    (probe) => {
      const pending = makePending({ meetingId: 'mtg-1' })
      const action = decideMountAction({ storeStatus: 'idle', pending, probe })
      expect(action).toEqual({ kind: 'reattach-poll', meetingId: 'mtg-1' })
    },
  )

  it.each<MeetingProbeResult>([{ kind: 'terminal' }, { kind: 'gone' }])(
    'discards stale entry for probe=%j and starts fresh',
    (probe) => {
      const pending = makePending({
        clientRecordingId: 'rec-old',
        meetingId: 'mtg-1',
      })
      const action = decideMountAction({ storeStatus: 'idle', pending, probe })
      expect(action).toEqual({
        kind: 'discard-and-start-fresh',
        clientRecordingId: 'rec-old',
      })
    },
  )

  it('defaults to reattach when idle + pending has meetingId but no probe supplied', () => {
    // Defensive default — the real caller (record.tsx) always supplies a
    // probe when this branch is reachable, but the function shouldn't
    // crash if the probe is missing.
    const pending = makePending({ meetingId: 'mtg-1' })
    const action = decideMountAction({ storeStatus: 'idle', pending })
    expect(action).toEqual({ kind: 'reattach-poll', meetingId: 'mtg-1' })
  })
})
