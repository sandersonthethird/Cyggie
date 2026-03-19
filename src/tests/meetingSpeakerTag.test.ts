import { describe, it, expect } from 'vitest'
import {
  mergeSpeakerTag,
  removeSpeakerTag,
  appendCompanyIfMissing,
} from '../main/ipc/meeting.ipc'

// ── mergeSpeakerTag ───────────────────────────────────────────────────────────

describe('mergeSpeakerTag', () => {
  it('adds contact name to speakerMap and contact id to contactMap', () => {
    const result = mergeSpeakerTag({}, {}, 0, 'contact-123', 'Andy Dunn')
    expect(result.speakerMap[0]).toBe('Andy Dunn')
    expect(result.contactMap[0]).toBe('contact-123')
  })

  it('overwrites an existing speaker name and contact link', () => {
    const result = mergeSpeakerTag(
      { 0: 'Speaker 0', 1: 'Jane Smith' },
      { 1: 'old-contact' },
      1,
      'new-contact',
      'Jane Doe'
    )
    expect(result.speakerMap[0]).toBe('Speaker 0')
    expect(result.speakerMap[1]).toBe('Jane Doe')
    expect(result.contactMap[1]).toBe('new-contact')
  })

  it('does not mutate the input maps', () => {
    const speakerMap = { 0: 'Speaker 0' }
    const contactMap = { 0: 'existing' }
    mergeSpeakerTag(speakerMap, contactMap, 1, 'c-1', 'Name')
    expect(speakerMap).toEqual({ 0: 'Speaker 0' })
    expect(contactMap).toEqual({ 0: 'existing' })
  })

  it('handles non-zero speaker indices', () => {
    const result = mergeSpeakerTag({}, {}, 3, 'c-3', 'Third Speaker')
    expect(result.speakerMap[3]).toBe('Third Speaker')
    expect(result.contactMap[3]).toBe('c-3')
    expect(Object.keys(result.speakerMap)).toHaveLength(1)
  })
})

// ── removeSpeakerTag ──────────────────────────────────────────────────────────

describe('removeSpeakerTag', () => {
  it('resets speaker name to default and removes contact link', () => {
    const result = removeSpeakerTag({ 0: 'Andy Dunn' }, { 0: 'contact-123' }, 0)
    expect(result.speakerMap[0]).toBe('Speaker 0')
    expect(result.contactMap[0]).toBeUndefined()
  })

  it('only affects the targeted index', () => {
    const result = removeSpeakerTag(
      { 0: 'Andy Dunn', 1: 'Jane Smith' },
      { 0: 'c-0', 1: 'c-1' },
      0
    )
    expect(result.speakerMap[1]).toBe('Jane Smith')
    expect(result.contactMap[1]).toBe('c-1')
  })

  it('is idempotent on an index with no contact link', () => {
    const result = removeSpeakerTag({ 0: 'Speaker 0' }, {}, 0)
    expect(result.speakerMap[0]).toBe('Speaker 0')
    expect(result.contactMap[0]).toBeUndefined()
  })

  it('does not mutate the input maps', () => {
    const speakerMap = { 0: 'Andy Dunn' }
    const contactMap = { 0: 'c-0' }
    removeSpeakerTag(speakerMap, contactMap, 0)
    expect(speakerMap[0]).toBe('Andy Dunn')
    expect(contactMap[0]).toBe('c-0')
  })

  it('uses the correct 0-indexed default name', () => {
    const result = removeSpeakerTag({ 3: 'Someone' }, { 3: 'c-3' }, 3)
    expect(result.speakerMap[3]).toBe('Speaker 3')
  })
})

// ── appendCompanyIfMissing ────────────────────────────────────────────────────

describe('appendCompanyIfMissing', () => {
  it('appends a new company name', () => {
    const result = appendCompanyIfMissing(['Acme Corp'], 'Widgets Inc')
    expect(result).toEqual(['Acme Corp', 'Widgets Inc'])
  })

  it('skips if name is already in the array', () => {
    const result = appendCompanyIfMissing(['Acme Corp', 'Widgets Inc'], 'Acme Corp')
    expect(result).toEqual(['Acme Corp', 'Widgets Inc'])
  })

  it('handles null input as empty array', () => {
    const result = appendCompanyIfMissing(null, 'Acme Corp')
    expect(result).toEqual(['Acme Corp'])
  })

  it('handles empty array input', () => {
    const result = appendCompanyIfMissing([], 'Acme Corp')
    expect(result).toEqual(['Acme Corp'])
  })

  it('does not mutate the original array', () => {
    const original = ['Acme Corp']
    appendCompanyIfMissing(original, 'New Co')
    expect(original).toEqual(['Acme Corp'])
  })

  it('returns same reference when name already present (no new array created)', () => {
    const original = ['Acme Corp']
    const result = appendCompanyIfMissing(original, 'Acme Corp')
    expect(result).toBe(original)
  })
})
