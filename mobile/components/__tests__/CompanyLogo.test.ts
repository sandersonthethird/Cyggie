import { describe, expect, test } from 'vitest'
import {
  computeLogoState,
  deriveLogoDomain,
  initialsForCompany,
  nextStage,
  resolveLogo,
} from '../CompanyLogo'

// Pure-logic tests for CompanyLogo's decision tree. UI rendering belongs in
// a future mobile-side runner with full RN bridge mocks; here we just lock
// in the three branches that drive what the user sees:
//
//   domain falsy        ──► Avatar(initials)
//   domain set, no err  ──► Image(Clearbit URL)
//   domain set, hasError──► Avatar(initials)
//
// The Clearbit-only URL strategy is what gives us a working onError path
// (s2 favicons return a globe icon on HTTP 200, so onError wouldn't fire).
// Lock that into the URL assertion so a regression to s2 fails loudly.

describe('initialsForCompany', () => {
  test('two-word name → first letters of first two words', () => {
    expect(initialsForCompany('Acme Corporation')).toBe('AC')
  })

  test('single word → first two letters', () => {
    expect(initialsForCompany('Stripe')).toBe('ST')
  })

  test('empty / whitespace → "?"', () => {
    expect(initialsForCompany('')).toBe('?')
    expect(initialsForCompany('   ')).toBe('?')
  })

  test('three+ words → only first two letters used', () => {
    expect(initialsForCompany('General Catalyst Partners')).toBe('GC')
  })
})

describe('computeLogoState', () => {
  test('null domain → avatar with initials', () => {
    const state = computeLogoState(null, 'Acme Corp', false)
    expect(state).toEqual({ kind: 'avatar', initials: 'AC' })
  })

  test('undefined domain → avatar', () => {
    const state = computeLogoState(undefined, 'Acme', false)
    expect(state.kind).toBe('avatar')
  })

  test('empty-string domain → avatar', () => {
    const state = computeLogoState('', 'Acme', false)
    expect(state.kind).toBe('avatar')
  })

  test('domain present, no error → Clearbit URL (not Google s2)', () => {
    const state = computeLogoState('acme.com', 'Acme', false)
    expect(state).toEqual({
      kind: 'image',
      uri: 'https://logo.clearbit.com/acme.com',
    })
    // Lock the choice of Clearbit specifically — see file header comment.
    if (state.kind === 'image') {
      expect(state.uri).not.toMatch(/google\.com\/s2/)
    }
  })

  test('domain with special chars → URL-encoded', () => {
    const state = computeLogoState('foo bar.com', 'Foo', false)
    if (state.kind !== 'image') throw new Error('expected image')
    expect(state.uri).toBe('https://logo.clearbit.com/foo%20bar.com')
  })

  test('hasError=true falls back to avatar even when domain is set', () => {
    const state = computeLogoState('acme.com', 'Acme Corp', true)
    expect(state).toEqual({ kind: 'avatar', initials: 'AC' })
  })
})

describe('resolveLogo', () => {
  test("stage=clearbit → Clearbit URL", () => {
    const r = resolveLogo('acme.com', 'Acme', 'clearbit')
    expect(r.kind).toBe('image')
    expect(r.uri).toBe('https://logo.clearbit.com/acme.com')
  })

  test("stage=favicon → Google s2 favicon URL", () => {
    const r = resolveLogo('acme.com', 'Acme', 'favicon')
    expect(r.kind).toBe('image')
    expect(r.uri).toMatch(/^https:\/\/www\.google\.com\/s2\/favicons\?sz=128&domain=acme\.com$/)
  })

  test("stage=avatar → initials", () => {
    const r = resolveLogo('acme.com', 'Acme Corp', 'avatar')
    expect(r).toEqual({ kind: 'avatar', initials: 'AC' })
  })

  test('null domain at any stage → avatar', () => {
    expect(resolveLogo(null, 'Acme', 'clearbit').kind).toBe('avatar')
    expect(resolveLogo(null, 'Acme', 'favicon').kind).toBe('avatar')
  })

  test('domain is URL-encoded so non-ASCII chars do not break the URL', () => {
    const r = resolveLogo('föo bar.com', 'Foo', 'favicon')
    expect(r.uri).toContain(encodeURIComponent('föo bar.com'))
  })
})

describe('nextStage', () => {
  test('clearbit → favicon → avatar (terminal)', () => {
    expect(nextStage('clearbit')).toBe('favicon')
    expect(nextStage('favicon')).toBe('avatar')
    expect(nextStage('avatar')).toBe('avatar')
  })
})

describe('deriveLogoDomain', () => {
  test('primaryDomain wins over websiteUrl', () => {
    expect(deriveLogoDomain('acme.com', 'https://stripe.com')).toBe('acme.com')
  })

  test('strips leading www. from primaryDomain', () => {
    expect(deriveLogoDomain('www.acme.com', null)).toBe('acme.com')
  })

  test('extracts host from full websiteUrl when domain missing', () => {
    expect(deriveLogoDomain(null, 'https://www.acme.com/about')).toBe('acme.com')
  })

  test('handles website without protocol', () => {
    expect(deriveLogoDomain(null, 'acme.com')).toBe('acme.com')
  })

  test('null + null → null (no logo possible)', () => {
    expect(deriveLogoDomain(null, null)).toBeNull()
  })

  test('whitespace-only inputs → null', () => {
    expect(deriveLogoDomain('   ', '   ')).toBeNull()
  })

  test('malformed websiteUrl → null', () => {
    expect(deriveLogoDomain(null, 'http://')).toBeNull()
  })
})
