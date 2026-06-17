import { describe, expect, it } from 'vitest'
import {
  COMPANY_FIELD_REGISTRY,
  CONTACT_FIELD_REGISTRY,
  COMPANY_FIELD_SKIP_SET,
  CONTACT_FIELD_SKIP_SET,
  formatCurrency,
  formatDateUTC,
  formatScalar,
  formatUnknown,
  humanize,
  humanizeKey,
  isPopulated,
  joinList,
} from './field-registry'

describe('formatCurrency', () => {
  it('scales to B/M/K and plain dollars; mirrors desktop', () => {
    expect(formatCurrency(2_500_000_000)).toBe('$2.5B')
    expect(formatCurrency(1_800_000)).toBe('$1.8M')
    expect(formatCurrency(12_000)).toBe('$12K')
    expect(formatCurrency(2)).toBe('$2')
    expect(formatCurrency(-5_000)).toBe('-$5K')
  })
  it('returns null (not "—") for empty so the row drops', () => {
    expect(formatCurrency(null)).toBeNull()
    expect(formatCurrency(undefined)).toBeNull()
    expect(formatCurrency(Number.NaN)).toBeNull()
  })
})

describe('formatDateUTC', () => {
  it('formats a midnight-UTC date without off-by-one', () => {
    // 2026-04-14 stored as midnight UTC must read "Apr 14, 2026" everywhere.
    expect(formatDateUTC('2026-04-14 00:00:00+00')).toBe('Apr 14, 2026')
    expect(formatDateUTC('2026-04-14T00:00:00.000Z')).toBe('Apr 14, 2026')
  })
  it('returns null for empty / unparseable', () => {
    expect(formatDateUTC(null)).toBeNull()
    expect(formatDateUTC('not-a-date')).toBeNull()
  })
})

describe('humanize / humanizeKey', () => {
  it('title-cases snake_case enum values', () => {
    expect(humanize('pre_seed')).toBe('Pre Seed')
    expect(humanize('safe')).toBe('Safe')
  })
  it('humanizes camelCase keys for the MORE fallback', () => {
    expect(humanizeKey('investmentMark')).toBe('Investment mark')
    expect(humanizeKey('warmIntroSource')).toBe('Warm intro source')
  })
})

describe('joinList / isPopulated', () => {
  it('joins non-empty string arrays, else null', () => {
    expect(joinList(['Sequoia', 'a16z'])).toBe('Sequoia, a16z')
    expect(joinList([])).toBeNull()
    expect(joinList(null)).toBeNull()
    expect(joinList(['', '  '])).toBeNull()
  })
  it('isPopulated rejects empty/blank/NaN/boolean', () => {
    expect(isPopulated('x')).toBe(true)
    expect(isPopulated('  ')).toBe(false)
    expect(isPopulated(0)).toBe(true)
    expect(isPopulated(Number.NaN)).toBe(false)
    expect(isPopulated(true)).toBe(false)
    expect(isPopulated(['a'])).toBe(true)
    expect(isPopulated([])).toBe(false)
  })
})

describe('formatScalar', () => {
  it('renders investmentMark as a plain number, NOT currency', () => {
    // investmentMark is a multiple (2.5×), so format:'number'.
    expect(formatScalar(2.5, 'number')).toBe('2.5')
  })
  it('renders months and humanized text', () => {
    expect(formatScalar(11, 'months')).toBe('11 mo')
    expect(formatScalar('pre_seed', 'text', true)).toBe('Pre Seed')
    expect(formatScalar('500000', 'text')).toBe('500000') // free-form text stays as-is
  })
  it('drops empties', () => {
    expect(formatScalar(null, 'text')).toBeNull()
    expect(formatScalar('', 'text')).toBeNull()
  })
})

describe('formatUnknown (MORE fallback)', () => {
  it('shows strings, ISO dates, numbers, and string arrays', () => {
    expect(formatUnknown('hello')).toBe('hello')
    expect(formatUnknown('2026-04-14T00:00:00Z')).toBe('Apr 14, 2026')
    expect(formatUnknown(42)).toBe('42')
    expect(formatUnknown(['a', 'b'])).toBe('a, b')
  })
  it('skips objects and object-arrays (recentMeetings/people)', () => {
    expect(formatUnknown([{ id: '1' }])).toBeNull()
    expect(formatUnknown({ a: 1 })).toBeNull()
    expect(formatUnknown(null)).toBeNull()
  })
})

describe('registry integrity', () => {
  it('has unique keys and known sections', () => {
    const coKeys = COMPANY_FIELD_REGISTRY.map((f) => f.key)
    expect(new Set(coKeys).size).toBe(coKeys.length)
    expect(new Set(COMPANY_FIELD_REGISTRY.map((f) => f.section))).toEqual(
      new Set(['OVERVIEW', 'FINANCIALS', 'INVESTMENT', 'LINKS']),
    )
    const ctKeys = CONTACT_FIELD_REGISTRY.map((f) => f.key)
    expect(new Set(ctKeys).size).toBe(ctKeys.length)
    expect(new Set(CONTACT_FIELD_REGISTRY.map((f) => f.section))).toEqual(
      new Set(['ABOUT', 'RELATIONSHIP', 'INVESTOR']),
    )
  })
  it('sentinel sources are skip-listed so they never double-render in MORE', () => {
    expect(COMPANY_FIELD_SKIP_SET.has('city')).toBe(true)
    expect(COMPANY_FIELD_SKIP_SET.has('websiteUrl')).toBe(true)
    expect(CONTACT_FIELD_SKIP_SET.has('typicalCheckSizeMin')).toBe(true)
  })
  it('registry keys are not also in the skip set (no contradiction)', () => {
    for (const f of COMPANY_FIELD_REGISTRY) {
      expect(COMPANY_FIELD_SKIP_SET.has(f.key)).toBe(false)
    }
    for (const f of CONTACT_FIELD_REGISTRY) {
      expect(CONTACT_FIELD_SKIP_SET.has(f.key)).toBe(false)
    }
  })
})
