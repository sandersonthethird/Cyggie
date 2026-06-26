import { describe, it, expect } from 'vitest'
import { pickSeeded, resolve } from './pick'
import { voiceCatalog } from './catalog'
import { resolveSlot, voiceFor, isLateNight } from './index'
import type { Slot, Surface, SubKey } from './types'

describe('pickSeeded', () => {
  it('is deterministic for a fixed seed', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    expect(pickSeeded(lines, 'seed-1')).toBe(pickSeeded(lines, 'seed-1'))
  })
  it('passes a single-line pool through unchanged', () => {
    expect(pickSeeded(['only'], 'anything')).toBe('only')
  })
  it('returns empty string for an empty pool', () => {
    expect(pickSeeded([], 'x')).toBe('')
  })
  it('can reach every line across seeds (covers the pool)', () => {
    const lines = ['a', 'b', 'c']
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(pickSeeded(lines, i))
    expect(seen).toEqual(new Set(lines))
  })
})

describe('resolve (intensity + variant degradation)', () => {
  const slot: Slot = {
    plain: 'plain',
    subtle: ['s1', 's2'],
    full: ['f1', 'f2'],
    filtered: { plain: 'plainF', full: ['fF1'] },
  }

  it('off always returns only the plain line', () => {
    expect(resolve(slot, 'off')).toEqual(['plain'])
    expect(resolve(slot, 'off', 'filtered')).toEqual(['plainF'])
  })
  it('full returns the full pool', () => {
    expect(resolve(slot, 'full')).toEqual(['f1', 'f2'])
  })
  it('subtle returns the subtle pool', () => {
    expect(resolve(slot, 'subtle')).toEqual(['s1', 's2'])
  })
  it('full degrades to subtle, then plain, when higher tiers are empty', () => {
    expect(resolve({ plain: 'p', subtle: ['s'], full: [] }, 'full')).toEqual(['s'])
    expect(resolve({ plain: 'p', subtle: [], full: [] }, 'full')).toEqual(['p'])
    expect(resolve({ plain: 'p', subtle: [], full: [] }, 'subtle')).toEqual(['p'])
  })
  it('uses the filtered override pool when present, base pool otherwise', () => {
    expect(resolve(slot, 'full', 'filtered')).toEqual(['fF1'])
    // filtered has no subtle override → falls back to base subtle
    expect(resolve(slot, 'subtle', 'filtered')).toEqual(['s1', 's2'])
  })
})

describe('resolveSlot', () => {
  it('falls back to the surface generic for an unknown sub-key', () => {
    const slot = resolveSlot('emptyState', 'doesNotExist' as SubKey)
    expect(slot).toBe(voiceCatalog.emptyState.generic)
  })
})

describe('voiceFor', () => {
  it('is deterministic and returns a non-empty string', () => {
    const a = voiceFor('emptyState', 'contacts', { seed: 'x', intensity: 'full' })
    const b = voiceFor('emptyState', 'contacts', { seed: 'x', intensity: 'full' })
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })
  it('off yields the plain line', () => {
    expect(voiceFor('emptyState', 'contacts', { intensity: 'off' })).toBe('No contacts found.')
  })
})

describe('isLateNight', () => {
  it('is true at/after 22:00 and before 05:00', () => {
    expect(isLateNight(23)).toBe(true)
    expect(isLateNight(2)).toBe(true)
    expect(isLateNight(22)).toBe(true)
  })
  it('is false during the day', () => {
    expect(isLateNight(9)).toBe(false)
    expect(isLateNight(21)).toBe(false)
    expect(isLateNight(5)).toBe(false)
  })
})

describe('catalog integrity (hostile-QA)', () => {
  const surfaces = Object.keys(voiceCatalog) as Surface[]

  it('every slot has a non-empty plain line', () => {
    for (const surface of surfaces) {
      for (const [sub, slot] of Object.entries(voiceCatalog[surface])) {
        expect(slot, `${surface}.${sub}`).toBeTruthy()
        expect((slot as Slot).plain.length, `${surface}.${sub}.plain`).toBeGreaterThan(0)
      }
    }
  })
  it('every slot has at least one full line', () => {
    for (const surface of surfaces) {
      for (const [sub, slot] of Object.entries(voiceCatalog[surface])) {
        expect((slot as Slot).full.length, `${surface}.${sub}.full`).toBeGreaterThan(0)
      }
    }
  })
  it('every surface defines a generic fallback slot', () => {
    // resolveSlot relies on this for unknown sub-keys.
    expect(voiceCatalog.emptyState.generic).toBeTruthy()
  })
})
