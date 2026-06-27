import { describe, it, expect } from 'vitest'
import { splitMultiValue, detectMultiValue, extractOptions } from '../shared/csv-multivalue'

describe('splitMultiValue', () => {
  it('keeps a single company name with a legal suffix as one value', () => {
    expect(splitMultiValue('Grow, Inc.')).toEqual(['Grow, Inc.'])
    expect(splitMultiValue('PowerToolsDev, Inc.')).toEqual(['PowerToolsDev, Inc.'])
    expect(splitMultiValue('Acme, LLC')).toEqual(['Acme, LLC'])
  })

  it('keeps a "City, ST" location as one value', () => {
    expect(splitMultiValue('New York, NY')).toEqual(['New York, NY'])
    expect(splitMultiValue('San Francisco, CA')).toEqual(['San Francisco, CA'])
  })

  it('splits a genuine multi-item list', () => {
    expect(splitMultiValue('B2B, SaaS, Fintech')).toEqual(['B2B', 'SaaS', 'Fintech'])
  })

  it('splits a list of suffixed names into one value each', () => {
    expect(splitMultiValue('Acme, Inc., Beta, LLC')).toEqual(['Acme, Inc.', 'Beta, LLC'])
  })

  it('handles single values, blanks, and trailing commas', () => {
    expect(splitMultiValue('Acme')).toEqual(['Acme'])
    expect(splitMultiValue('')).toEqual([])
    expect(splitMultiValue('Acme,')).toEqual(['Acme'])
    expect(splitMultiValue('  Acme ,  Beta ')).toEqual(['Acme', 'Beta'])
  })
})

describe('detectMultiValue', () => {
  it('is false for suffix names / locations', () => {
    expect(detectMultiValue(['Grow, Inc.', 'PowerToolsDev, Inc.'])).toBe(false)
    expect(detectMultiValue(['New York, NY', 'San Francisco, CA'])).toBe(false)
    expect(detectMultiValue(['Acme'])).toBe(false)
  })

  it('is true for a genuine list in any sample', () => {
    expect(detectMultiValue(['Acme', 'B2B, SaaS, Fintech'])).toBe(true)
    expect(detectMultiValue(['Acme, Inc., Beta, LLC'])).toBe(true)
  })
})

describe('extractOptions', () => {
  it('extracts suffix-aware, de-duplicated options', () => {
    expect(extractOptions(['B2B, SaaS', 'SaaS, Fintech'])).toEqual(['B2B', 'SaaS', 'Fintech'])
  })

  it('does not split a single suffixed name into bogus options', () => {
    expect(extractOptions(['Grow, Inc.'])).toEqual(['Grow, Inc.'])
  })

  it('caps at 20 options', () => {
    const many = Array.from({ length: 30 }, (_, i) => `opt${i}`).join(', ')
    expect(extractOptions([many])).toHaveLength(20)
  })
})
