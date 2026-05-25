import { describe, expect, test } from 'vitest'
import { computeLogoState, initialsForCompany } from '../CompanyLogo'

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
