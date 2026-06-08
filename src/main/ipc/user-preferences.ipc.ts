import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { getAllPreferences, setPreference } from '@cyggie/db/sqlite/repositories/user-preferences.repo'
import { syncPreferenceChange } from '../services/preference-sync.service'
import { getCurrentUserId } from '../security/current-user'

export function registerUserPreferencesHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USER_PREF_GET_ALL, () => {
    return getAllPreferences(getDatabase())
  })

  ipcMain.handle(IPC_CHANNELS.USER_PREF_SET, (_event, key: string, value: string) => {
    setPreference(getDatabase(), key, value)
    // Part E — emit to the sync outbox so the change reaches Neon (gateway/mobile).
    syncPreferenceChange(getCurrentUserId(), key)
  })
}
