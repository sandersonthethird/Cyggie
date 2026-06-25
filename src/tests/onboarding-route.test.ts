import { describe, it, expect } from 'vitest'
import { routeOnboarding } from '../renderer/lib/onboarding-route'

// Pure dispatcher matrix for the onboarding gate. The routing a signed-in user
// hits must never get wrong (e.g. sending an admin to create-workspace).

describe('routeOnboarding', () => {
  it('shows loading while auth status is unknown', () => {
    expect(routeOnboarding({ authStatus: 'unknown', action: null, hasFirm: false })).toBe('loading')
  })

  it('shows welcome when signed out', () => {
    expect(routeOnboarding({ authStatus: 'signed_out', action: null, hasFirm: false })).toBe('welcome')
  })

  it('routes a user WITH a firm straight to the app (firm membership wins over a stale action)', () => {
    expect(routeOnboarding({ authStatus: 'signed_in', action: null, hasFirm: true })).toBe('app')
    expect(routeOnboarding({ authStatus: 'signed_in', action: 'create_workspace', hasFirm: true })).toBe('app')
    expect(routeOnboarding({ authStatus: 'signed_in', action: 'returning', hasFirm: false })).toBe('app')
  })

  it('routes a pending-invite user to join_firm', () => {
    expect(routeOnboarding({ authStatus: 'signed_in', action: 'join_firm', hasFirm: false })).toBe('join_firm')
  })

  it('routes a firmless, inviteless user to create_workspace (incl. no action at all)', () => {
    expect(routeOnboarding({ authStatus: 'signed_in', action: 'create_workspace', hasFirm: false })).toBe('create_workspace')
    expect(routeOnboarding({ authStatus: 'signed_in', action: null, hasFirm: false })).toBe('create_workspace')
  })

  it("gmail-vs-firm-email trap: a firmless 'member' user (sandy.cass@gmail) → create_workspace, NOT the firm", () => {
    // Mirrors the live Neon state: the gmail user has firm_id=null.
    expect(routeOnboarding({ authStatus: 'signed_in', action: null, hasFirm: false })).toBe('create_workspace')
  })
})
