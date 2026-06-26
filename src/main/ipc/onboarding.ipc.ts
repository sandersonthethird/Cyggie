import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'

// =============================================================================
// onboarding.ipc.ts — STUB invite handler for the first-run Team step.
//
// This branch has NO gateway invite endpoint, so onboarding invites are kept
// LOCAL (in the renderer's onboarding state / prefs) and this handler merely
// acknowledges the call so the UI has a real IPC seam to swap later.
//
// TODO(team-invites): when the gateway exposes an invite endpoint, replace the
// ack with an authed POST (mirror the firm-invite path on
// feat/onboarding-gate-dispatcher) and return the created invite.
// =============================================================================

export function registerOnboardingHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ONBOARDING_TEAM_INVITE,
    (_e, input: { email: string }) => {
      const email = (input?.email ?? '').trim().toLowerCase()
      console.log(`[Onboarding] team invite (stub) queued locally email=${email}`)
      return { ok: true as const, email, stub: true as const }
    },
  )
}
