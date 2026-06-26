// =============================================================================
// onboarding-logic.ts — PURE cores for the first-run flow (no React, no IPC).
//
// Kept pure so the fiddly logic (slug derivation, email validation, and the
// smart-backfill gate decision) is unit-tested without rendering.
//
//   slugify ───────────────▶ workspace URL
//   isValidEmail ──────────▶ team invites
//   deriveOnboardingStatus ▶ gate: skip / full flow / resume-at-first-incomplete
// =============================================================================

/** The four setup steps the flat progress bar spans (sign-in is step 0, no bar). */
export type SetupStepId = 'workspace' | 'google' | 'keys' | 'team'
export const SETUP_STEPS: SetupStepId[] = ['workspace', 'google', 'keys', 'team']

/** Step indices in the full flow (0 = SignIn … 5 = Done). */
export const STEP = {
  signin: 0,
  workspace: 1,
  google: 2,
  keys: 3,
  team: 4,
  done: 5,
} as const

// ── slugify ──────────────────────────────────────────────────────────────────

/** Firm name → workspace URL slug: lowercase, non-alphanumerics → hyphens,
 *  collapse/trim hyphens, cap at 48 chars. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') // re-trim if the slice landed on a hyphen
}

// ── email ──────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim())
}

// ── smart-backfill gate decision ─────────────────────────────────────────────

export interface OnboardingSignals {
  /** Persisted completion flag already true → straight to app. */
  onboardingComplete: boolean
  signedIn: boolean
  calendarConnected: boolean
  hasDeepgram: boolean
  hasAnthropic: boolean
  /** Workspace firm name already saved (prefs). */
  hasFirmName: boolean
}

export type GateDecision =
  | { kind: 'app' } // already complete → render the app
  | { kind: 'flow'; startStep: number; doneSteps: SetupStepId[] }

export interface OnboardingStatus {
  steps: Record<SetupStepId, boolean>
  /** Any signal that the install has been used/configured before. */
  priorUse: boolean
  /** Every CORE setup step (workspace, google, keys) is done. Team is optional. */
  allCoreDone: boolean
  /** First setup step (by SETUP_STEPS order) that isn't done; null if all done. */
  firstIncomplete: SetupStepId | null
}

/** Core steps that count toward "this install is set up" (Team is optional). */
const CORE_STEPS: SetupStepId[] = ['workspace', 'google', 'keys']

export function deriveOnboardingStatus(s: OnboardingSignals): OnboardingStatus {
  const steps: Record<SetupStepId, boolean> = {
    workspace: s.hasFirmName,
    google: s.calendarConnected,
    keys: s.hasDeepgram && s.hasAnthropic,
    team: false, // optional, never blocks
  }
  const priorUse =
    s.calendarConnected || s.signedIn || s.hasDeepgram || s.hasAnthropic || s.hasFirmName
  const allCoreDone = CORE_STEPS.every((k) => steps[k])
  const firstIncomplete = SETUP_STEPS.find((k) => !steps[k]) ?? null
  return { steps, priorUse, allCoreDone, firstIncomplete }
}

/**
 * The gate's branch (Lock 1 — smart backfill):
 *
 *   complete                       → app
 *   !complete & !priorUse          → full flow from SignIn (brand-new user)
 *   !complete & priorUse & allCore → app (treat as already onboarded; caller
 *                                    should also persist onboardingComplete=true)
 *   !complete & priorUse & partial → flow, pre-checking done steps, starting at
 *                                    the first incomplete setup step
 */
export function decideGate(s: OnboardingSignals): GateDecision {
  if (s.onboardingComplete) return { kind: 'app' }

  const status = deriveOnboardingStatus(s)
  if (!status.priorUse) {
    return { kind: 'flow', startStep: STEP.signin, doneSteps: [] }
  }
  if (status.allCoreDone) return { kind: 'app' }

  const doneSteps = SETUP_STEPS.filter((k) => status.steps[k])
  const startStep = status.firstIncomplete
    ? STEP[status.firstIncomplete]
    : STEP.done
  return { kind: 'flow', startStep, doneSteps }
}
