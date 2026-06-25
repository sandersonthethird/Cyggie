// =============================================================================
// onboarding-route.ts — PURE dispatcher for the desktop onboarding gate.
//
// Mirrors mobile's index.tsx routing (computeOnboardingAction on the gateway →
// an `action` hint in the OAuth callback). Kept pure (no React, no IPC) so the
// routing matrix is unit-tested without rendering — same pattern as the GC drain
// core + attachment validation.
//
//   not signed in            → 'welcome'        (sign in with Google)
//   signed in + returning    → 'app'            (firm_id already set)
//   signed in + create_ws    → 'create_workspace'
//   signed in + join_firm    → 'join_firm'      (a pending invite matched the email)
//   signed in + no action    → 'create_workspace' (no firm, no invite ⇒ create)
//   loading (status unknown)  → 'loading'
// =============================================================================

export type OnboardingAction = 'returning' | 'create_workspace' | 'join_firm'

export type OnboardingScreen =
  | 'loading'
  | 'welcome'
  | 'create_workspace'
  | 'join_firm'
  | 'app'

export interface OnboardingRouteInput {
  /** Cyggie-Cloud auth status. 'unknown' = still loading the status. */
  authStatus: 'unknown' | 'signed_out' | 'signed_in'
  /** The action hint from the OAuth callback / gateway. null if not yet known. */
  action: OnboardingAction | null
  /** Whether the signed-in user already has a firm (firm_id set). */
  hasFirm: boolean
}

export function routeOnboarding(input: OnboardingRouteInput): OnboardingScreen {
  if (input.authStatus === 'unknown') return 'loading'
  if (input.authStatus === 'signed_out') return 'welcome'

  // Signed in. A user with a firm is always 'returning' → the app, regardless of
  // a stale action hint (firm membership is the source of truth).
  if (input.hasFirm || input.action === 'returning') return 'app'
  if (input.action === 'join_firm') return 'join_firm'
  // create_workspace, or no action at all (no firm + no invite) ⇒ create.
  return 'create_workspace'
}
