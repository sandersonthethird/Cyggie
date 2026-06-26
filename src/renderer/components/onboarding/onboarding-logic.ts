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

/** The setup steps the flat progress bar spans (sign-in is step 0, no bar). */
export type SetupStepId = 'workspace' | 'google' | 'keys' | 'import' | 'team'
export const SETUP_STEPS: SetupStepId[] = ['workspace', 'google', 'keys', 'import', 'team']

/** Step indices in the full flow (0 = SignIn … 6 = Done). */
export const STEP = {
  signin: 0,
  workspace: 1,
  google: 2,
  keys: 3,
  import: 4,
  team: 5,
  done: 6,
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
  /** CSV import step already completed (prefs). Optional — never blocks the gate. */
  csvImported?: boolean
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
    import: Boolean(s.csvImported), // optional, never blocks
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

// ── firm field profile (from CSV import) ─────────────────────────────────────
//
// The set of fields a firm actually mapped/created in their CSV import tells us
// which fields they care about — a signal that later steers targeted enrichment
// (see getFirmFieldProfile in the main process). Persisted to the synced
// `user_preferences` key `onboarding:firm-field-profile`.

/** Minimal shape of a CSV mapping we read here (subset of csv-import's FieldMapping). */
export interface ProfileMappingInput {
  targetEntity: 'contact' | 'company' | null
  targetField: string | null
  customFieldLabel?: string
}

export interface FirmFieldProfile {
  version: 1
  /** snake_case field keys (or `custom:<defId>` tokens) the firm provided data for. */
  contact: string[]
  company: string[]
  source: 'onboarding-csv'
  updatedAt: string
}

/**
 * Field key from a custom-field label. MUST stay in sync with `toFieldKey` in
 * csv-import.service.ts so profile keys line up with the keys the import creates.
 * (Collision suffixes like _2 can't be predicted here — the profile is a soft
 * signal, not a strict foreign key.)
 */
export function fieldKeyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
}

/**
 * Derive the firm's important-field set from the mappings used across one or more
 * imported files. A field "matters" if the user mapped a column to it (built-in or
 * existing custom) or created a custom field for it. Skipped columns are ignored.
 * Returns deterministic, de-duplicated, sorted key lists per entity.
 */
export function deriveFieldProfile(
  mappingsPerFile: ProfileMappingInput[][],
): Pick<FirmFieldProfile, 'version' | 'contact' | 'company' | 'source'> {
  const contact = new Set<string>()
  const company = new Set<string>()

  for (const mappings of mappingsPerFile) {
    for (const m of mappings) {
      if (m.targetEntity == null) continue // skipped column
      const bucket = m.targetEntity === 'contact' ? contact : company
      if (m.targetField != null) {
        bucket.add(m.targetField) // built-in field key, or `custom:<defId>` token
      } else if (m.customFieldLabel && m.customFieldLabel.trim()) {
        bucket.add(fieldKeyFromLabel(m.customFieldLabel)) // newly-created custom field
      }
    }
  }

  return {
    version: 1,
    source: 'onboarding-csv',
    contact: [...contact].sort(),
    company: [...company].sort(),
  }
}
