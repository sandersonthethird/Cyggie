import { describe, it, expect } from 'vitest'
import { safeParseJson, extractString, extractNumber } from '../main/utils/json-utils'

describe('safeParseJson', () => {
  it('parses a valid JSON object', () => {
    const result = safeParseJson('{"name":"Alice","age":30}')
    expect(result).toEqual({ name: 'Alice', age: 30 })
  })

  it('strips markdown json fences', () => {
    const result = safeParseJson('```json\n{"x":1}\n```')
    expect(result).toEqual({ x: 1 })
  })

  it('strips plain code fences', () => {
    const result = safeParseJson('```\n{"y":2}\n```')
    expect(result).toEqual({ y: 2 })
  })

  it('returns null for a JSON array', () => {
    expect(safeParseJson('[1,2,3]')).toBeNull()
  })

  it('returns null for a JSON primitive', () => {
    expect(safeParseJson('"hello"')).toBeNull()
    expect(safeParseJson('42')).toBeNull()
    expect(safeParseJson('true')).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(safeParseJson('not json at all')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(safeParseJson('')).toBeNull()
  })

  it('handles objects with nested nulls', () => {
    const result = safeParseJson('{"a":null,"b":{"c":null}}')
    expect(result).toEqual({ a: null, b: { c: null } })
  })
})

describe('extractString', () => {
  it('returns trimmed string for non-empty string', () => {
    expect(extractString('  hello  ')).toBe('hello')
  })

  it('returns null for empty string', () => {
    expect(extractString('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(extractString('   ')).toBeNull()
  })

  it('returns null for non-string types', () => {
    expect(extractString(42)).toBeNull()
    expect(extractString(null)).toBeNull()
    expect(extractString(undefined)).toBeNull()
    expect(extractString({})).toBeNull()
  })
})

describe('extractNumber', () => {
  it('returns a numeric value for a number', () => {
    expect(extractNumber(42)).toBe(42)
    expect(extractNumber(0)).toBe(0)
    expect(extractNumber(-7.5)).toBe(-7.5)
  })

  it('converts numeric strings', () => {
    expect(extractNumber('3.14')).toBe(3.14)
    expect(extractNumber('100')).toBe(100)
  })

  it('returns null for null and undefined', () => {
    expect(extractNumber(null)).toBeNull()
    expect(extractNumber(undefined)).toBeNull()
  })

  it('returns null for NaN / Infinity', () => {
    expect(extractNumber(NaN)).toBeNull()
    expect(extractNumber(Infinity)).toBeNull()
    expect(extractNumber('abc')).toBeNull()
  })
})
