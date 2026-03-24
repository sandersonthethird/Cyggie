import { describe, it, expect } from 'vitest'
import {
  resolveLayoutPref,
  saveLayoutPref,
  propagateLayoutPref,
  clearPerEntityPref,
} from '../renderer/utils/layoutPref'

// ---------------------------------------------------------------------------
// In-memory store that mirrors usePreferencesStore's getJSON/setJSON semantics.
//
//   setJSON(key, null)  → stores "null" string
//   getJSON(key, null)  → JSON.parse("null") = null   (falls through ??)
//   getJSON(key, null)  → undefined raw → returns null (falls through ??)
//
// Both "not set" and "explicitly set to null" yield null from getJSON, so ??
// correctly resolves to the next tier in all three-tier lookups.
// ---------------------------------------------------------------------------

function makeStore(seed: Record<string, unknown> = {}) {
  const raw: Record<string, string> = {}
  for (const [k, v] of Object.entries(seed)) {
    raw[k] = JSON.stringify(v)
  }
  const getJSON = <U>(key: string, defaultValue: U): U => {
    const s = raw[key]
    if (s == null) return defaultValue
    try {
      return JSON.parse(s) as U
    } catch {
      return defaultValue
    }
  }
  const setJSON = (key: string, value: unknown): void => {
    raw[key] = JSON.stringify(value)
  }
  return { getJSON, setJSON, raw }
}

const BASE = 'cyggie:company-header-chip-order'
const ID = 'co-abc'
const PROFILE = 'vc_fund'

// ── resolveLayoutPref ────────────────────────────────────────────────────────

describe('resolveLayoutPref', () => {
  it('returns per-entity value when set', () => {
    const { getJSON } = makeStore({ [`${BASE}:entity:${ID}`]: ['b', 'a'] })
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['b', 'a'])
  })

  it('falls back to entity-type template when no per-entity value', () => {
    const { getJSON } = makeStore({ [`${BASE}:entity:${PROFILE}`]: ['x', 'y'] })
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['x', 'y'])
  })

  it('falls back to global key when no per-entity or entity-type value', () => {
    const { getJSON } = makeStore({ [BASE]: ['g1', 'g2'] })
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['g1', 'g2'])
  })

  it('falls back to defaultValue when no tiers have data', () => {
    const { getJSON } = makeStore()
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, ['default'])).toEqual(['default'])
  })

  it('per-entity value takes priority over entity-type and global', () => {
    const { getJSON } = makeStore({
      [`${BASE}:entity:${ID}`]: ['entity-wins'],
      [`${BASE}:entity:${PROFILE}`]: ['entity-type'],
      [BASE]: ['global'],
    })
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['entity-wins'])
  })

  it('entity-type template takes priority over global', () => {
    const { getJSON } = makeStore({
      [`${BASE}:entity:${PROFILE}`]: ['entity-type-wins'],
      [BASE]: ['global'],
    })
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['entity-type-wins'])
  })

  it('skips entity-type tier when profileKey is null (contact path)', () => {
    // Only global key is set; with null profileKey, entity-type tier is skipped
    const { getJSON } = makeStore({
      [`${BASE}:entity:null`]: ['should-be-ignored'],
      [BASE]: ['global-contact-default'],
    })
    expect(resolveLayoutPref(getJSON, BASE, ID, null, [])).toEqual(['global-contact-default'])
  })

  it('returns defaultValue via contact path when no per-entity or global', () => {
    const { getJSON } = makeStore()
    expect(resolveLayoutPref(getJSON, BASE, ID, null, ['fallback'])).toEqual(['fallback'])
  })
})

// ── saveLayoutPref ──────────────────────────────────────────────────────────

describe('saveLayoutPref', () => {
  it('writes to per-entity key', () => {
    const { setJSON, raw } = makeStore()
    saveLayoutPref(setJSON, BASE, ID, ['a', 'b'])
    expect(JSON.parse(raw[`${BASE}:entity:${ID}`])).toEqual(['a', 'b'])
  })

  it('does not write to global or entity-type keys', () => {
    const { setJSON, raw } = makeStore()
    saveLayoutPref(setJSON, BASE, ID, ['a'])
    expect(raw[BASE]).toBeUndefined()
    expect(raw[`${BASE}:entity:${PROFILE}`]).toBeUndefined()
  })
})

// ── propagateLayoutPref ─────────────────────────────────────────────────────

describe('propagateLayoutPref', () => {
  it('copies per-entity value to entity-type key when profileKey is non-null', () => {
    const { getJSON, setJSON, raw } = makeStore({
      [`${BASE}:entity:${ID}`]: ['a', 'b'],
    })
    propagateLayoutPref(getJSON, setJSON, BASE, ID, PROFILE)
    expect(JSON.parse(raw[`${BASE}:entity:${PROFILE}`])).toEqual(['a', 'b'])
  })

  it('copies per-entity value to base key when profileKey is null (contact path)', () => {
    const { getJSON, setJSON, raw } = makeStore({
      [`${BASE}:entity:${ID}`]: ['c', 'd'],
    })
    propagateLayoutPref(getJSON, setJSON, BASE, ID, null)
    expect(JSON.parse(raw[BASE])).toEqual(['c', 'd'])
  })

  it('does not overwrite target when per-entity key is null', () => {
    // clearPerEntityPref sets the per-entity key to null (JSON.stringify(null) = "null")
    const { getJSON, setJSON, raw } = makeStore({
      [`${BASE}:entity:${ID}`]: null,
      [`${BASE}:entity:${PROFILE}`]: ['original'],
    })
    propagateLayoutPref(getJSON, setJSON, BASE, ID, PROFILE)
    // Target should be unchanged
    expect(JSON.parse(raw[`${BASE}:entity:${PROFILE}`])).toEqual(['original'])
  })

  it('does not overwrite target when per-entity key is not set', () => {
    const { getJSON, setJSON, raw } = makeStore({
      [`${BASE}:entity:${PROFILE}`]: ['untouched'],
    })
    propagateLayoutPref(getJSON, setJSON, BASE, ID, PROFILE)
    expect(JSON.parse(raw[`${BASE}:entity:${PROFILE}`])).toEqual(['untouched'])
  })
})

// ── clearPerEntityPref ──────────────────────────────────────────────────────

describe('clearPerEntityPref', () => {
  it('sets per-entity key to null (stored as "null")', () => {
    const { setJSON, raw } = makeStore({ [`${BASE}:entity:${ID}`]: ['a', 'b'] })
    clearPerEntityPref(setJSON, BASE, ID)
    expect(raw[`${BASE}:entity:${ID}`]).toBe('null')
  })

  it('subsequent resolveLayoutPref falls through to entity-type template', () => {
    const { getJSON, setJSON } = makeStore({
      [`${BASE}:entity:${ID}`]: ['per-entity'],
      [`${BASE}:entity:${PROFILE}`]: ['entity-template'],
    })
    clearPerEntityPref(setJSON, BASE, ID)
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['entity-template'])
  })

  it('subsequent resolveLayoutPref falls through to global when no entity-type template', () => {
    const { getJSON, setJSON } = makeStore({
      [`${BASE}:entity:${ID}`]: ['per-entity'],
      [BASE]: ['global'],
    })
    clearPerEntityPref(setJSON, BASE, ID)
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, [])).toEqual(['global'])
  })

  it('subsequent resolveLayoutPref returns defaultValue when all tiers are clear', () => {
    const { getJSON, setJSON } = makeStore({
      [`${BASE}:entity:${ID}`]: ['per-entity'],
    })
    clearPerEntityPref(setJSON, BASE, ID)
    expect(resolveLayoutPref(getJSON, BASE, ID, PROFILE, ['default'])).toEqual(['default'])
  })
})
