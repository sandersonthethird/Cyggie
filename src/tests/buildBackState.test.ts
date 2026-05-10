/**
 * Tests for buildBackState — captures originating list URL into navigation state.
 */
import { describe, it, expect } from 'vitest'
import type { Location } from 'react-router-dom'
import { buildBackState } from '../renderer/utils/backNavState'

function makeLocation(pathname: string, search = ''): Location {
  return {
    pathname,
    search,
    hash: '',
    state: null,
    key: 'k',
  }
}

describe('buildBackState', () => {
  it('captures pathname + search as `from`', () => {
    const loc = makeLocation('/companies', '?priority=high&type=investor')
    expect(buildBackState(loc, 'Companies')).toEqual({
      backLabel: 'Companies',
      from: '/companies?priority=high&type=investor',
    })
  })

  it('handles pathname with no search params', () => {
    const loc = makeLocation('/contacts')
    expect(buildBackState(loc, 'Contacts')).toEqual({
      backLabel: 'Contacts',
      from: '/contacts',
    })
  })

  it('echoes the provided backLabel verbatim', () => {
    const loc = makeLocation('/companies')
    expect(buildBackState(loc, 'Custom Label').backLabel).toBe('Custom Label')
  })
})
