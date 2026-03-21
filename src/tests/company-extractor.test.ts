import { describe, it, expect } from 'vitest'
import { humanizeDomainName } from '../main/utils/company-extractor'

describe('humanizeDomainName', () => {
  it('splits CamelCase domain names — new path', () => {
    expect(humanizeDomainName('AcmeCorp')).toBe('Acme Corp')
  })

  it('splits multi-word CamelCase', () => {
    expect(humanizeDomainName('BowleyCapital')).toBe('Bowley Capital')
  })

  it('title-cases all-lowercase with no CamelCase or DOMAIN_WORDS match', () => {
    // "acme" is not in DOMAIN_WORDS and no CamelCase → just title-cased
    expect(humanizeDomainName('acmecorp')).toBe('Acmecorp')
  })

  it('segments DOMAIN_WORDS — existing path (regression)', () => {
    expect(humanizeDomainName('redswanventures')).toBe('Red Swan Ventures')
  })

  it('segments with new legal suffix "corp"', () => {
    expect(humanizeDomainName('nextcorp')).toBe('Next Corp')
  })

  it('segments with new legal suffix "inc"', () => {
    expect(humanizeDomainName('labsinc')).toBe('Labs Inc')
  })

  it('handles hyphen-delimited — existing path (regression)', () => {
    expect(humanizeDomainName('acme-corp')).toBe('Acme Corp')
  })

  it('handles underscore-delimited', () => {
    expect(humanizeDomainName('acme_labs')).toBe('Acme Labs')
  })
})
