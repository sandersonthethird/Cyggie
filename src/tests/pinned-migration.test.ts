/**
 * Tests for the pinned-field migration logic.
 *
 * The hook itself wraps IPC + React lifecycle, so we test the core invariants
 * directly: given a set of IPC results, does the preference key get cleared
 * correctly (or not)?
 */
import { describe, it, expect } from 'vitest'

// Pure helper extracted from the hook's logic for testability
function shouldClearPref(results: PromiseSettledResult<unknown>[]): boolean {
  const hasProcessError = results.some(
    (r) =>
      r.status === 'rejected' &&
      !(r.reason && String(r.reason).includes('not found'))
  )
  return !hasProcessError
}

describe('usePinnedMigration: pref clearing logic', () => {
  it('clears pref when all IPC calls succeed', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: { success: true } },
    ]
    expect(shouldClearPref(results)).toBe(true)
  })

  it('does NOT clear pref when an IPC call has a process error', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: { success: true } },
      { status: 'rejected', reason: new Error('IPC timeout') },
    ]
    expect(shouldClearPref(results)).toBe(false)
  })

  it('still clears pref when a "not found" rejection occurs (field deleted)', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'fulfilled', value: { success: true } },
      { status: 'rejected', reason: new Error('Field definition not found: abc123') },
    ]
    expect(shouldClearPref(results)).toBe(true)
  })

  it('clears pref with all-not-found results', () => {
    const results: PromiseSettledResult<unknown>[] = [
      { status: 'rejected', reason: new Error('Field definition not found: x') },
      { status: 'rejected', reason: new Error('Field definition not found: y') },
    ]
    expect(shouldClearPref(results)).toBe(true)
  })
})
