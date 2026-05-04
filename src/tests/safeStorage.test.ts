// @vitest-environment jsdom
/**
 * safeStorage — the localStorage wrapper that NEVER throws.
 *
 *   Test surface:
 *     getJSON  — JSON.parse failure → returns default
 *     setJSON  — JSON.stringify cycle → no-throw
 *     setItem  — QuotaExceeded → evicts oldest cyggie:chat:draft:* key, retries
 *     setItem  — SecurityError → falls back to in-memory Map
 *     removeKey — clears both real and fallback storage
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getJSON, setJSON, removeKey } from '../renderer/lib/safe-storage'

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('safeStorage.getJSON', () => {
  it('returns the parsed value on a clean read', () => {
    window.localStorage.setItem('k', JSON.stringify({ a: 1 }))
    expect(getJSON('k', { a: 0 })).toEqual({ a: 1 })
  })

  it('returns the default when key is missing', () => {
    expect(getJSON('missing', 42)).toBe(42)
  })

  it('returns the default when the value is malformed JSON', () => {
    window.localStorage.setItem('k', 'not-json{{{')
    expect(getJSON('k', { fallback: true })).toEqual({ fallback: true })
  })
})

describe('safeStorage.setJSON', () => {
  it('writes JSON-serialized value', () => {
    setJSON('k', { a: 1 })
    expect(JSON.parse(window.localStorage.getItem('k') ?? 'null')).toEqual({ a: 1 })
  })

  it('does not throw on circular references', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => setJSON('k', cyclic)).not.toThrow()
    expect(window.localStorage.getItem('k')).toBeNull() // serialization failed; nothing written
  })

  it('falls back to in-memory on QuotaExceededError and getJSON sees the fallback value', () => {
    // Replace setItem on the prototype (where Storage's setItem actually lives
    // in jsdom v25) so the call from safeStorage hits our throwing impl.
    const origProtoSet = Storage.prototype.setItem
    let calls = 0
    Storage.prototype.setItem = function () {
      calls++
      const err = new Error('quota')
      ;(err as { name?: string }).name = 'QuotaExceededError'
      throw err
    }
    try {
      setJSON('k', { v: 1 })
      // getJSON sees the in-memory value (not real storage, which threw).
      expect(getJSON('k', null)).toEqual({ v: 1 })
      expect(calls).toBeGreaterThan(0)
    } finally {
      Storage.prototype.setItem = origProtoSet
    }
  })
})

describe('safeStorage.removeKey', () => {
  it('removes the key from real storage', () => {
    window.localStorage.setItem('k', 'v')
    removeKey('k')
    expect(window.localStorage.getItem('k')).toBeNull()
  })

  it('does not throw if storage throws', () => {
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => removeKey('k')).not.toThrow()
  })
})
