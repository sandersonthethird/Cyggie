import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  startSignIn,
  signOut,
  getStatus,
  setAuthBroadcastTarget,
} from '../auth/cyggie-auth'
import {
  claimWorkspace,
  joinFirm,
  acceptByEmail,
  listInvites,
  createInvite,
  revokeInvite,
  FirmRequestError,
} from '../services/cyggie-firm'

/** Map a FirmRequestError to a renderer-friendly { ok:false, code, message }. */
function firmError(err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof FirmRequestError) return { ok: false, code: err.code, message: err.message }
  return { ok: false, code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Request failed.' }
}

// =============================================================================
// cyggie-auth.ipc.ts — IPC surface for the renderer Cloud Sync panel.
//
//   CYGGIE_AUTH_SIGN_IN   → POST /auth/google/start { redirect_target='desktop' }
//                            → shell.openExternal(authUrl). Callback fires
//                              asynchronously via macOS open-url; the renderer
//                              observes CYGGIE_AUTH_STATUS_CHANGED.
//   CYGGIE_AUTH_SIGN_OUT  → best-effort gateway logout + wipe local tokens.
//   CYGGIE_AUTH_STATUS    → returns { signedIn, email, userId } for the
//                            renderer's initial-mount render.
//
// Status pushes (CYGGIE_AUTH_STATUS_CHANGED) are emitted from cyggie-auth.ts
// after every sign-in / sign-out / refresh.
// =============================================================================

export function registerCyggieAuthIpc(mainWindow: BrowserWindow): void {
  // Bind the broadcast target so cyggie-auth can push status updates to
  // the renderer without an explicit handle. Re-bind when a new window
  // opens (call this again from the second window's setup).
  setAuthBroadcastTarget(mainWindow.webContents)

  ipcMain.handle(IPC_CHANNELS.CYGGIE_AUTH_SIGN_IN, async () => {
    return startSignIn({ deviceLabel: 'Desktop' })
  })

  ipcMain.handle(IPC_CHANNELS.CYGGIE_AUTH_SIGN_OUT, async () => {
    await signOut()
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.CYGGIE_AUTH_STATUS, () => {
    return getStatus()
  })

  // ── Firm onboarding (M6) ──────────────────────────────────────────────────
  // Each returns { ok:true, ... } or { ok:false, code, message } so the
  // onboarding screens can surface the gateway's named errors as clear copy.

  ipcMain.handle(
    IPC_CHANNELS.CYGGIE_FIRM_CLAIM,
    async (_e, input: { name: string; slug: string; primaryEmailDomain?: string | null }) => {
      try {
        return { ok: true as const, firm: await claimWorkspace(input) }
      } catch (err) {
        return firmError(err)
      }
    },
  )

  ipcMain.handle(IPC_CHANNELS.CYGGIE_FIRM_JOIN, async (_e, input: { token?: string }) => {
    try {
      // token present → magic-link join; absent → email-match accept (no infra).
      const firm = input?.token ? await joinFirm(input.token) : await acceptByEmail()
      return { ok: true as const, firm }
    } catch (err) {
      return firmError(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CYGGIE_FIRM_INVITES_LIST, async () => {
    try {
      return { ok: true as const, invites: await listInvites() }
    } catch (err) {
      return firmError(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CYGGIE_FIRM_INVITE_CREATE, async (_e, input: { email: string }) => {
    try {
      return { ok: true as const, ...(await createInvite(input.email)) }
    } catch (err) {
      return firmError(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.CYGGIE_FIRM_INVITE_REVOKE, async (_e, input: { id: string }) => {
    try {
      await revokeInvite(input.id)
      return { ok: true as const }
    } catch (err) {
      return firmError(err)
    }
  })
}
