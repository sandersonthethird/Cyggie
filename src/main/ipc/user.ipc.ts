import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getCurrentUserProfile, updateCurrentUserProfile } from '../security/current-user'

export function registerUserHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USER_GET_CURRENT, () => {
    return getCurrentUserProfile()
  })

  ipcMain.handle(
    IPC_CHANNELS.USER_UPDATE_CURRENT,
    (_event, data: { displayName: string; email?: string | null }) => {
      const displayName = (data?.displayName || '').trim()
      if (!displayName) throw new Error('displayName is required')
      return updateCurrentUserProfile({
        displayName,
        email: data?.email ?? null
      })
    }
  )
}
