import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getCurrentUserProfile, updateCurrentUserProfile } from '../security/current-user'
import { pushUserProfile } from '../services/gateway-profile'

export function registerUserHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USER_GET_CURRENT, () => {
    return getCurrentUserProfile()
  })

  ipcMain.handle(
    IPC_CHANNELS.USER_UPDATE_CURRENT,
    (_event, data: {
      displayName: string
      firstName?: string | null
      lastName?: string | null
      email?: string | null
      title?: string | null
      jobFunction?: string | null
    }) => {
      const displayName = (data?.displayName || '').trim()
      if (!displayName) throw new Error('displayName is required')
      const updated = updateCurrentUserProfile({
        displayName,
        firstName: data?.firstName ?? null,
        lastName: data?.lastName ?? null,
        email: data?.email ?? null,
        title: data?.title,
        jobFunction: data?.jobFunction
      })
      // T25 — propagate identity fields to Neon so the gateway enhance route
      // builds the same task-attribution prompt as the desktop summarizer.
      // Best-effort, fire-and-forget (mirrors the credential push on save).
      void pushUserProfile({
        firstName: updated.firstName,
        lastName: updated.lastName,
        title: updated.title,
        jobFunction: updated.jobFunction,
      })
      return updated
    }
  )
}
