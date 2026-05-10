import { describe, it, expect } from 'vitest'
import { isEmptyValue, getVisibleFieldCount } from '../renderer/utils/visibleFieldCount'

describe('isEmptyValue (PropertyRow parity)', () => {
  it('null is empty', () => { expect(isEmptyValue(null)).toBe(true) })
  it('undefined is empty', () => { expect(isEmptyValue(undefined)).toBe(true) })
  it('empty string is empty', () => { expect(isEmptyValue('')).toBe(true) })
  it('0 is NOT empty', () => { expect(isEmptyValue(0)).toBe(false) })
  it('false is NOT empty', () => { expect(isEmptyValue(false)).toBe(false) })
  it('whitespace string is NOT empty', () => { expect(isEmptyValue(' ')).toBe(false) })
  it('non-empty string is NOT empty', () => { expect(isEmptyValue('hi')).toBe(false) })
})

describe('getVisibleFieldCount', () => {
  const values: Record<string, unknown> = {
    industry: 'SaaS',
    foundingYear: 2018,
    arr: null,
    burn: '',
    notes: undefined,
    employees: 0,            // 0 is non-empty
    isPublic: false,         // false is non-empty
  }
  const get = (k: string) => values[k]

  it('counts non-empty fields only', () => {
    expect(getVisibleFieldCount(['industry', 'foundingYear', 'arr', 'burn', 'notes'], get, [])).toBe(2)
  })

  it('treats 0 and false as non-empty', () => {
    expect(getVisibleFieldCount(['employees', 'isPublic'], get, [])).toBe(2)
  })

  it('excludes hidden fields from the count even when non-empty', () => {
    expect(getVisibleFieldCount(['industry', 'foundingYear'], get, ['industry'])).toBe(1)
  })

  it('returns 0 when all fields empty', () => {
    expect(getVisibleFieldCount(['arr', 'burn', 'notes'], get, [])).toBe(0)
  })

  it('returns 0 when fieldKeys is empty', () => {
    expect(getVisibleFieldCount([], get, [])).toBe(0)
  })
})
