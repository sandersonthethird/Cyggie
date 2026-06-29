import { describe, it, expect } from 'vitest'
import {
  slugify,
  isValidEmail,
  deriveOnboardingStatus,
  decideGate,
  deriveFieldProfile,
  fieldKeyFromLabel,
  deriveSharedRelPath,
  looksLikeCloudMount,
  STEP,
  SETUP_STEPS,
  type OnboardingSignals,
  type ProfileMappingInput,
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
  it('all core done → allCoreDone; import is the first remaining optional step', () => {
    const s = deriveOnboardingStatus({
      ...base, hasFirmName: true, calendarConnected: true, hasDeepgram: true, hasAnthropic: true,
    })
    expect(s.allCoreDone).toBe(true)
    // import + team are optional; import comes first in SETUP_STEPS order.
    expect(s.firstIncomplete).toBe('import')
  })
  it('import step is optional — never affects allCoreDone', () => {
    const withImport = deriveOnboardingStatus({
      ...base, hasFirmName: true, calendarConnected: true, hasDeepgram: true, hasAnthropic: true, csvImported: true,
    })
    expect(withImport.steps.import).toBe(true)
    expect(withImport.allCoreDone).toBe(true)
    expect(withImport.firstIncomplete).toBe('team')
  })
  it('storage step (Slice 4) is always done + optional — never firstIncomplete, never core', () => {
    // Even on a totally fresh install, storage is "done" (local default), so the
    // resume point is workspace, not storage.
    const fresh = deriveOnboardingStatus(base)
    expect(fresh.steps.storage).toBe(true)
    expect(fresh.firstIncomplete).toBe('workspace')
    // storage sits after workspace in the bar order.
    expect(SETUP_STEPS).toEqual(['workspace', 'storage', 'google', 'keys', 'import', 'team'])
    expect(STEP.storage).toBe(2)
    expect(STEP.done).toBe(7)
  })
})

describe('deriveSharedRelPath / looksLikeCloudMount (Slice 4)', () => {
  it('strips the CloudStorage/GoogleDrive-<acct>/ prefix to a mount-relative spec', () => {
    expect(
      deriveSharedRelPath(
        '/Users/sandy/Library/CloudStorage/GoogleDrive-sandy@firm.com/Shared drives/Cyggie/Meeting Notes',
      ),
    ).toBe('Shared drives/Cyggie/Meeting Notes')
  })
  it('returns null for a path that is not under a Google Drive mount', () => {
    expect(deriveSharedRelPath('/Users/sandy/Documents/Cyggie')).toBeNull()
    expect(deriveSharedRelPath('/Users/sandy/Library/CloudStorage/Dropbox/Shared')).toBeNull()
  })
  it('trims a trailing slash', () => {
    expect(
      deriveSharedRelPath('/Users/x/Library/CloudStorage/GoogleDrive-x@y.com/My Drive/Cyggie/'),
    ).toBe('My Drive/Cyggie')
  })
  it('flags cloud-synced locations for the private-folder warning', () => {
    expect(looksLikeCloudMount('/Users/x/Library/CloudStorage/GoogleDrive-x@y.com/My Drive')).toBe(true)
    expect(looksLikeCloudMount('/Users/x/Dropbox/Cyggie')).toBe(true)
    expect(looksLikeCloudMount('/Users/x/Documents/Cyggie')).toBe(false)
  })
})

describe('deriveFieldProfile', () => {
  it('collects built-in field keys per entity from mapped columns', () => {
    const mappings: ProfileMappingInput[] = [
      { targetEntity: 'contact', targetField: 'email' },
      { targetEntity: 'contact', targetField: 'title' },
      { targetEntity: 'company', targetField: 'industry' },
    ]
    const p = deriveFieldProfile([mappings])
    expect(p.contact).toEqual(['email', 'title'])
    expect(p.company).toEqual(['industry'])
    expect(p.version).toBe(1)
    expect(p.source).toBe('onboarding-csv')
  })

  it('uses the slugified label for newly-created custom fields', () => {
    const mappings: ProfileMappingInput[] = [
      { targetEntity: 'company', targetField: null, customFieldLabel: 'Deal Lead' },
    ]
    expect(deriveFieldProfile([mappings]).company).toEqual(['deal_lead'])
    expect(fieldKeyFromLabel('Deal Lead')).toBe('deal_lead')
  })

  it('ignores skipped columns (targetEntity null) and blank custom labels', () => {
    const mappings: ProfileMappingInput[] = [
      { targetEntity: null, targetField: null },
      { targetEntity: 'contact', targetField: null, customFieldLabel: '   ' },
      { targetEntity: 'contact', targetField: 'email' },
    ]
    expect(deriveFieldProfile([mappings]).contact).toEqual(['email'])
  })

  it('keeps the custom:<defId> token for existing custom-field mappings', () => {
    const mappings: ProfileMappingInput[] = [
      { targetEntity: 'contact', targetField: 'custom:def-123' },
    ]
    expect(deriveFieldProfile([mappings]).contact).toEqual(['custom:def-123'])
  })

  it('unions + de-dupes + sorts keys across multiple files', () => {
    const fileA: ProfileMappingInput[] = [
      { targetEntity: 'contact', targetField: 'title' },
      { targetEntity: 'contact', targetField: 'email' },
    ]
    const fileB: ProfileMappingInput[] = [
      { targetEntity: 'contact', targetField: 'email' }, // dup across files
      { targetEntity: 'contact', targetField: 'city' },
    ]
    expect(deriveFieldProfile([fileA, fileB]).contact).toEqual(['city', 'email', 'title'])
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
      // storage is always "done" (local default) so it pre-checks alongside keys.
      expect(d.doneSteps).toEqual(['storage', 'keys']) // workspace/google/team not done
      expect(d.startStep).toBe(STEP.workspace) // first incomplete in order
    }
  })
})
