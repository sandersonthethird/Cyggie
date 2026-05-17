import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { getAllPreferences, setPreference } from '@cyggie/db/sqlite/repositories/user-preferences.repo'

export function registerUserPreferencesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USER_PREF_GET_ALL, () => {
    return getAllPreferences(getDatabase())
  })

  ipcMain.handle(IPC_CHANNELS.USER_PREF_SET, (_event, key: string, value: string) => {
    setPreference(getDatabase(), key, value)
  })
}
