// Unit tests for the T8 lamport ceiling validator.

import { describe, expect, it } from 'vitest'
import {
  validateClientLamport,
  MAX_LAMPORT_SKEW_MS,
} from '../src/sync/validate-lamport'

const NOW = 1_779_500_000_000 // arbitrary fixed wall clock for the suite

describe('validateClientLamport', () => {
  it('accepts a current-time lamport', () => {
    const v = validateClientLamport(String(NOW), NOW)
    expect(v.valid).toBe(true)
    if (v.valid) expect(v.bigint).toBe(BigInt(NOW))
  })

  it('accepts a lamport in the past (LWW handles staleness downstream)', () => {
    const v = validateClientLamport('1000000', NOW)
    expect(v.valid).toBe(true)
  })

  it('accepts a lamport at exactly now + skew tolerance', () => {
    const v = validateClientLamport(String(NOW + MAX_LAMPORT_SKEW_MS), NOW)
    expect(v.valid).toBe(true)
  })

  it('rejects a lamport just past now + skew tolerance', () => {
    const v = validateClientLamport(String(NOW + MAX_LAMPORT_SKEW_MS + 1), NOW)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('too_far_future')
  })

  it('rejects BigInt.MAX (the forgery scenario)', () => {
    const huge = (2n ** 63n - 1n).toString()
    const v = validateClientLamport(huge, NOW)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('too_far_future')
  })

  it('rejects garbage strings as unparseable', () => {
    const v = validateClientLamport('not-a-number', NOW)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('unparseable')
  })

  it('rejects empty string as unparseable', () => {
    const v = validateClientLamport('', NOW)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('unparseable')
  })

  it('accepts lamport = 0 (cold-start case)', () => {
    const v = validateClientLamport('0', NOW)
    expect(v.valid).toBe(true)
    if (v.valid) expect(v.bigint).toBe(0n)
  })

  it('uses Date.now() as the default reference', () => {
    // Without a `nowMs` arg, the function should fall back to live Date.now().
    // We test by passing a value clearly in the past — should be valid.
    const v = validateClientLamport('1')
    expect(v.valid).toBe(true)
  })
})
