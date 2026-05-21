import { describe, expect, it } from 'vitest'
import { decideNextRetryDelay, shouldDeadLetter, MAX_RETRIES } from '../retry'

describe('sync/retry', () => {
  describe('decideNextRetryDelay', () => {
    it('returns the curve: 1s, 2s, 4s, 16s, then 60s ceiling', () => {
      expect(decideNextRetryDelay(0)).toBe(1_000)
      expect(decideNextRetryDelay(1)).toBe(2_000)
      expect(decideNextRetryDelay(2)).toBe(4_000)
      expect(decideNextRetryDelay(3)).toBe(16_000)
      expect(decideNextRetryDelay(4)).toBe(60_000)
      expect(decideNextRetryDelay(9)).toBe(60_000)
      expect(decideNextRetryDelay(100)).toBe(60_000)
    })

    it('treats negative retries as the first slot', () => {
      expect(decideNextRetryDelay(-1)).toBe(1_000)
      expect(decideNextRetryDelay(-10)).toBe(1_000)
    })
  })

  describe('shouldDeadLetter', () => {
    it('returns false until retries hits MAX_RETRIES', () => {
      for (let i = 0; i < MAX_RETRIES; i++) {
        expect(shouldDeadLetter(i)).toBe(false)
      }
      expect(shouldDeadLetter(MAX_RETRIES)).toBe(true)
      expect(shouldDeadLetter(MAX_RETRIES + 1)).toBe(true)
      expect(shouldDeadLetter(100)).toBe(true)
    })
  })
})
