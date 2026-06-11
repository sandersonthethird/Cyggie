import { describe, it, expect } from 'vitest'
import {
  parseMultiselectValue,
  serializeCustomFieldValue,
  mergeStageValues,
  CANONICAL_STAGE_ORDER,
} from '../shared/custom-field-values'

describe('parseMultiselectValue', () => {
  it('returns [] for empty / nullish input', () => {
    expect(parseMultiselectValue('')).toEqual([])
    expect(parseMultiselectValue('   ')).toEqual([])
    expect(parseMultiselectValue(null)).toEqual([])
    expect(parseMultiselectValue(undefined)).toEqual([])
  })

  it('parses canonical comma form', () => {
    expect(parseMultiselectValue('Pre-Seed,Seed,Series A')).toEqual([
      'Pre-Seed',
      'Seed',
      'Series A',
    ])
  })

  it('trims whitespace around comma members', () => {
    expect(parseMultiselectValue('Seed, Series A , Growth')).toEqual([
      'Seed',
      'Series A',
      'Growth',
    ])
  })

  it('parses legacy JSON-array form', () => {
    expect(parseMultiselectValue('["Pre-Seed","Seed","Series A"]')).toEqual([
      'Pre-Seed',
      'Seed',
      'Series A',
    ])
  })

  it('falls back to comma split on malformed JSON', () => {
    // Leading '[' but not valid JSON → fall through to comma split (keeps the
    // raw text rather than throwing).
    expect(parseMultiselectValue('["Pre-Seed')).toEqual(['["Pre-Seed'])
  })

  it('drops empty members', () => {
    expect(parseMultiselectValue('Seed,,Series A,')).toEqual(['Seed', 'Series A'])
  })
})

describe('serializeCustomFieldValue', () => {
  it('multiselect array → comma-joined valueText', () => {
    expect(serializeCustomFieldValue('multiselect', ['Pre-Seed', 'Seed'])).toEqual({
      valueText: 'Pre-Seed,Seed',
    })
  })

  it('multiselect string passes through as valueText', () => {
    expect(serializeCustomFieldValue('multiselect', 'Seed,Series A')).toEqual({
      valueText: 'Seed,Series A',
    })
  })

  it('multiselect null → null valueText', () => {
    expect(serializeCustomFieldValue('multiselect', null)).toEqual({ valueText: null })
  })

  it('number → valueNumber (null for blank)', () => {
    expect(serializeCustomFieldValue('number', '42')).toEqual({ valueNumber: 42 })
    expect(serializeCustomFieldValue('currency', 1000)).toEqual({ valueNumber: 1000 })
    expect(serializeCustomFieldValue('number', '')).toEqual({ valueNumber: null })
    expect(serializeCustomFieldValue('number', null)).toEqual({ valueNumber: null })
  })

  it('boolean → valueBoolean', () => {
    expect(serializeCustomFieldValue('boolean', true)).toEqual({ valueBoolean: true })
    expect(serializeCustomFieldValue('boolean', '')).toEqual({ valueBoolean: false })
  })

  it('date → valueDate', () => {
    expect(serializeCustomFieldValue('date', '2026-06-10')).toEqual({ valueDate: '2026-06-10' })
    expect(serializeCustomFieldValue('date', null)).toEqual({ valueDate: null })
  })

  it('text / default → valueText', () => {
    expect(serializeCustomFieldValue('text', 'hello')).toEqual({ valueText: 'hello' })
    expect(serializeCustomFieldValue('url', null)).toEqual({ valueText: null })
  })
})

describe('mergeStageValues', () => {
  it('merges JSON + comma forms, deduped, in canonical order', () => {
    // existing comma, one JSON custom value, one comma custom value
    const merged = mergeStageValues(
      'Series A,Pre-Seed',
      '["Seed","Series A"]',
      'Growth',
    )
    expect(merged).toBe('Pre-Seed,Seed,Series A,Growth')
  })

  it('dedupes overlapping values', () => {
    expect(mergeStageValues('Seed', 'Seed', '["Seed"]')).toBe('Seed')
  })

  it('drops non-canonical options', () => {
    expect(mergeStageValues('Seed,NotAStage', 'AlsoBogus')).toBe('Seed')
  })

  it('returns empty string when union is empty', () => {
    expect(mergeStageValues(null)).toBe('')
    expect(mergeStageValues('', '[]')).toBe('')
  })

  it('orders strictly by CANONICAL_STAGE_ORDER regardless of input order', () => {
    expect(mergeStageValues('Late Stage,Pre-Seed,Series B')).toBe(
      'Pre-Seed,Series B,Late Stage',
    )
  })

  it('round-trips with serialize: merged value re-serializes identically', () => {
    const merged = mergeStageValues('["Seed","Series A"]')
    expect(serializeCustomFieldValue('multiselect', parseMultiselectValue(merged))).toEqual({
      valueText: merged,
    })
  })

  it('CANONICAL_STAGE_ORDER covers all options used by the legacy fields', () => {
    // Old custom Focus / Target Stage options were subsets of this list.
    for (const v of ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Growth']) {
      expect(CANONICAL_STAGE_ORDER).toContain(v)
    }
  })
})
