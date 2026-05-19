import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  startSignIn,
  signOut,
  getStatus,
  setAuthBroadcastTarget,
} from '../auth/cyggie-auth'

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
}
