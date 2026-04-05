/**
 * Tests for SmartFilters component and isPresetActive helper.
 *
 * Coverage diagram:
 *
 *   isPresetActive
 *     ├── all paramKeys present → true
 *     ├── one paramKey missing  → false
 *     └── extra unrelated params present → true (presence-only check)
 *
 *   handleSort state transformation (pure logic from Companies/Contacts)
 *     ├── no shift, key not in array    → [{ key, dir: 'asc' }]
 *     ├── no shift, key already in array (sole) → toggle direction
 *     ├── no shift, key in array with others    → drop others, toggle
 *     ├── shift + new key   → appended to end
 *     └── shift + existing  → removed from array
 *
 *   contact inline create name splitting
 *     ├── single-word name  → { firstName: 'Alice', lastName: '' }
 *     ├── two-word name     → { firstName: 'Alice', lastName: 'Smith' }
 *     └── three-word name   → { firstName: 'Alice Marie', lastName: 'Smith' }
 *
 *   contact scope filter
 *     ├── scope='investors' → only contacts with contactType='investor'
 *     └── scope='all'       → no type filter applied
 */

import { describe, it, expect } from 'vitest'
import { isPresetActive } from '../renderer/components/crm/SmartFilters'
import type { FilterPreset } from '../renderer/components/crm/SmartFilters'
import { CONTACT_SCOPE_TO_TYPE } from '../renderer/components/contact/contactColumns'
import type { SortKey } from '../renderer/components/crm/tableUtils'

// ─── isPresetActive ────────────────────────────────────────────────────────────

const NO_TOUCH_PRESET: FilterPreset = {
  id: 'no-touch-30',
  label: 'No touch in 30 days',
  getParams: () => ({ lastTouchpoint_max: '2025-01-01' }),
  paramKeys: ['lastTouchpoint_max']
}

const MULTI_KEY_PRESET: FilterPreset = {
  id: 'needs-followup',
  label: 'Needs follow-up',
  getParams: () => ({ nextFollowupDate_min: '2000-01-01', nextFollowupDate_max: '2026-01-01' }),
  paramKeys: ['nextFollowupDate_min', 'nextFollowupDate_max']
}

describe('isPresetActive', () => {
  it('returns true when all paramKeys present', () => {
    const params = new URLSearchParams({ lastTouchpoint_max: '2025-01-01' })
    expect(isPresetActive(NO_TOUCH_PRESET, params)).toBe(true)
  })

  it('returns false when one paramKey missing', () => {
    const params = new URLSearchParams({ nextFollowupDate_min: '2000-01-01' })
    expect(isPresetActive(MULTI_KEY_PRESET, params)).toBe(false)
  })

  it('returns true when all paramKeys present alongside extra unrelated params', () => {
    const params = new URLSearchParams({
      lastTouchpoint_max: '2025-01-01',
      sortKey: 'name',
      groupBy: 'pipelineStage'
    })
    expect(isPresetActive(NO_TOUCH_PRESET, params)).toBe(true)
  })

  it('returns true for multi-key preset when all keys present', () => {
    const params = new URLSearchParams({
      nextFollowupDate_min: '2000-01-01',
      nextFollowupDate_max: '2026-01-01'
    })
    expect(isPresetActive(MULTI_KEY_PRESET, params)).toBe(true)
  })

  it('presence-only: does NOT compare values — any value for the key is active', () => {
    // Even if the date has changed since the preset was applied, it remains active
    const params = new URLSearchParams({ lastTouchpoint_max: '1999-12-31' })
    expect(isPresetActive(NO_TOUCH_PRESET, params)).toBe(true)
  })
})

// ─── handleSort state transformation (pure logic extracted for unit tests) ────

/** Pure function mirroring the handleSort logic in Companies.tsx / Contacts.tsx */
function handleSort(sort: SortKey[], key: string, shiftHeld: boolean, defaultKey = 'lastTouchpoint'): SortKey[] {
  const existing = sort.findIndex((s) => s.key === key)
  let newSort: SortKey[]
  if (shiftHeld) {
    newSort = existing >= 0 ? sort.filter(s => s.key !== key) : [...sort, { key, dir: 'asc' }]
  } else {
    if (existing >= 0) {
      const prevDir = sort[existing].dir
      newSort = [{ key, dir: prevDir === 'asc' ? 'desc' : 'asc' }]
    } else {
      newSort = [{ key, dir: 'asc' }]
    }
  }
  if (newSort.length === 0) newSort = [{ key: defaultKey, dir: 'desc' }]
  return newSort
}

describe('handleSort', () => {
  it('no shift, key not in array → single asc sort on that key', () => {
    const result = handleSort([{ key: 'name', dir: 'asc' }], 'priority', false)
    expect(result).toEqual([{ key: 'priority', dir: 'asc' }])
  })

  it('no shift, key already sole in array → toggle direction', () => {
    const result = handleSort([{ key: 'priority', dir: 'asc' }], 'priority', false)
    expect(result).toEqual([{ key: 'priority', dir: 'desc' }])
  })

  it('no shift, key in array with other keys → drop others and toggle direction', () => {
    const sort: SortKey[] = [{ key: 'priority', dir: 'asc' }, { key: 'lastTouchpoint', dir: 'desc' }]
    const result = handleSort(sort, 'priority', false)
    expect(result).toEqual([{ key: 'priority', dir: 'desc' }])
  })

  it('shift + new key → appended to end', () => {
    const sort: SortKey[] = [{ key: 'priority', dir: 'asc' }]
    const result = handleSort(sort, 'lastTouchpoint', true)
    expect(result).toEqual([
      { key: 'priority', dir: 'asc' },
      { key: 'lastTouchpoint', dir: 'asc' }
    ])
  })

  it('shift + existing key → removed from array', () => {
    const sort: SortKey[] = [{ key: 'priority', dir: 'asc' }, { key: 'lastTouchpoint', dir: 'desc' }]
    const result = handleSort(sort, 'priority', true)
    expect(result).toEqual([{ key: 'lastTouchpoint', dir: 'desc' }])
  })

  it('shift removing last key → falls back to default sort', () => {
    const sort: SortKey[] = [{ key: 'priority', dir: 'asc' }]
    const result = handleSort(sort, 'priority', true, 'lastTouchpoint')
    expect(result).toEqual([{ key: 'lastTouchpoint', dir: 'desc' }])
  })
})

// ─── Contact inline create name splitting ─────────────────────────────────────

/** Mirrors the token logic in Contacts.tsx handleCreateInline */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const tokens = fullName.trim().split(/\s+/)
  const firstName = tokens.slice(0, -1).join(' ') || tokens[0] || ''
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : ''
  return { firstName, lastName }
}

describe('contact inline create name splitting', () => {
  it('single-word name: firstName = word, lastName = empty', () => {
    expect(splitName('Alice')).toEqual({ firstName: 'Alice', lastName: '' })
  })

  it('two-word name: firstName = first token, lastName = last token', () => {
    expect(splitName('Alice Smith')).toEqual({ firstName: 'Alice', lastName: 'Smith' })
  })

  it('three-word name: firstName = first two tokens, lastName = last token', () => {
    expect(splitName('Alice Marie Smith')).toEqual({ firstName: 'Alice Marie', lastName: 'Smith' })
  })

  it('extra whitespace trimmed', () => {
    expect(splitName('  Alice   Smith  ')).toEqual({ firstName: 'Alice', lastName: 'Smith' })
  })
})

// ─── Contact scope filter ─────────────────────────────────────────────────────

interface MinimalContact { id: string; contactType: string | null }

function applyScope(contacts: MinimalContact[], scope: string): MinimalContact[] {
  const typeFilter = CONTACT_SCOPE_TO_TYPE[scope as keyof typeof CONTACT_SCOPE_TO_TYPE] ?? null
  if (!typeFilter) return contacts
  return contacts.filter(c => c.contactType === typeFilter)
}

const CONTACTS: MinimalContact[] = [
  { id: '1', contactType: 'investor' },
  { id: '2', contactType: 'founder' },
  { id: '3', contactType: 'investor' },
  { id: '4', contactType: 'operator' },
  { id: '5', contactType: null }
]

describe('contact scope filter', () => {
  it('scope=all returns all contacts', () => {
    expect(applyScope(CONTACTS, 'all')).toHaveLength(CONTACTS.length)
  })

  it('scope=investors returns only investors', () => {
    const result = applyScope(CONTACTS, 'investors')
    expect(result.every(c => c.contactType === 'investor')).toBe(true)
    expect(result).toHaveLength(2)
  })

  it('scope=founders returns only founders', () => {
    const result = applyScope(CONTACTS, 'founders')
    expect(result.every(c => c.contactType === 'founder')).toBe(true)
    expect(result).toHaveLength(1)
  })

  it('scope=operators returns only operators', () => {
    const result = applyScope(CONTACTS, 'operators')
    expect(result.every(c => c.contactType === 'operator')).toBe(true)
    expect(result).toHaveLength(1)
  })

  it('scope filter excludes null contactType contacts', () => {
    const result = applyScope(CONTACTS, 'investors')
    expect(result.find(c => c.contactType === null)).toBeUndefined()
  })
})
