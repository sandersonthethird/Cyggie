import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  authorizeGmail,
  disconnectGmail,
  isGmailConnected,
  storeGoogleClientCredentials
} from '../calendar/google-auth'

export function registerGmailHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GMAIL_CONNECT,
    async (_event, clientId?: string, clientSecret?: string) => {
      const trimmedClientId = (clientId || '').trim()
      if (trimmedClientId) {
        storeGoogleClientCredentials(trimmedClientId, (clientSecret || '').trim())
      }
      await authorizeGmail()
      return { connected: true }
    }
  )

  ipcMain.handle(IPC_CHANNELS.GMAIL_DISCONNECT, () => {
    disconnectGmail()
    return { connected: false }
  })

  ipcMain.handle(IPC_CHANNELS.GMAIL_IS_CONNECTED, () => {
    return isGmailConnected()
  })
}
