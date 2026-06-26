import { describe, it, expect } from 'vitest'
import {
  slugify,
  isValidEmail,
  deriveOnboardingStatus,
  decideGate,
  STEP,
  type OnboardingSignals,
} from '../renderer/components/onboarding/onboarding-logic'

describe('slugify', () => {
  it('lowercases, hyphenates non-alphanumerics, trims/collapses hyphens', () => {
    expect(slugify('Red Swan Ventures')).toBe('red-swan-ventures')
    expect(slugify('  Acme & Co.  ')).toBe('acme-co')
    expect(slugify('A//B__C')).toBe('a-b-c')
  })
  it('never starts/ends with a hyphen, caps length, handles empty', () => {
    expect(slugify('---Hi---')).toBe('hi')
    expect(slugify('')).toBe('')
    const long = slugify('x'.repeat(80))
    expect(long.length).toBeLessThanOrEqual(48)
    expect(long.endsWith('-')).toBe(false)
  })
})

describe('isValidEmail', () => {
  it('accepts normal addresses (trimmed)', () => {
    expect(isValidEmail('a@b.com')).toBe(true)
    expect(isValidEmail('  teammate@firm.co  ')).toBe(true)
  })
  it('rejects malformed', () => {
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@b.com', 'a@.com']) {
      expect(isValidEmail(bad)).toBe(false)
    }
  })
})

const base: OnboardingSignals = {
  onboardingComplete: false,
  signedIn: false,
  calendarConnected: false,
  hasDeepgram: false,
  hasAnthropic: false,
  hasFirmName: false,
}

describe('deriveOnboardingStatus', () => {
  it('fresh install → nothing done, no prior use', () => {
    const s = deriveOnboardingStatus(base)
    expect(s.priorUse).toBe(false)
    expect(s.allCoreDone).toBe(false)
    expect(s.firstIncomplete).toBe('workspace')
  })
  it('keys require BOTH providers', () => {
    expect(deriveOnboardingStatus({ ...base, hasDeepgram: true }).steps.keys).toBe(false)
    expect(deriveOnboardingStatus({ ...base, hasDeepgram: true, hasAnthropic: true }).steps.keys).toBe(true)
  })
  it('all core done (team optional) → allCoreDone, no firstIncomplete among core', () => {
    const s = deriveOnboardingStatus({
      ...base, hasFirmName: true, calendarConnected: true, hasDeepgram: true, hasAnthropic: true,
    })
    expect(s.allCoreDone).toBe(true)
    expect(s.firstIncomplete).toBe('team') // only the optional one remains
  })
})

describe('decideGate (smart backfill)', () => {
  it('already complete → app', () => {
    expect(decideGate({ ...base, onboardingComplete: true })).toEqual({ kind: 'app' })
  })
  it('brand-new user (no prior use) → full flow from SignIn', () => {
    expect(decideGate(base)).toEqual({ kind: 'flow', startStep: STEP.signin, doneSteps: [] })
  })
  it('existing fully-set-up install → app (auto-skip, no re-onboard)', () => {
    const d = decideGate({
      ...base, calendarConnected: true, hasDeepgram: true, hasAnthropic: true, hasFirmName: true,
    })
    expect(d).toEqual({ kind: 'app' })
  })
  it('half-set-up install → flow starting at first incomplete, done steps pre-checked', () => {
    // Signed in + keys present, but no Google and no firm name.
    const d = decideGate({ ...base, signedIn: true, hasDeepgram: true, hasAnthropic: true })
    expect(d.kind).toBe('flow')
    if (d.kind === 'flow') {
      expect(d.doneSteps).toEqual(['keys']) // keys done; workspace/google/team not
      expect(d.startStep).toBe(STEP.workspace) // first incomplete in order
    }
  })
})
