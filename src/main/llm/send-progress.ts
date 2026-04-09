import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'

export function sendProgress(text: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CHAT_PROGRESS, text)
    }
  }
}
