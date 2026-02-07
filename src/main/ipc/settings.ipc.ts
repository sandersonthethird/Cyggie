import { ipcMain, safeStorage } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as settingsRepo from '../database/repositories/settings.repo'

const ENCRYPTED_KEYS = new Set(['deepgramApiKey', 'claudeApiKey'])

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_event, key: string) => {
    const value = settingsRepo.getSetting(key)
    if (value && ENCRYPTED_KEYS.has(key) && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'))
      } catch {
        return value
      }
    }
    return value
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, key: string, value: string) => {
    let storedValue = value
    if (ENCRYPTED_KEYS.has(key) && safeStorage.isEncryptionAvailable()) {
      storedValue = safeStorage.encryptString(value).toString('base64')
    }
    settingsRepo.setSetting(key, storedValue)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, () => {
    const all = settingsRepo.getAllSettings()
    // Decrypt sensitive values
    for (const key of ENCRYPTED_KEYS) {
      if (all[key] && safeStorage.isEncryptionAvailable()) {
        try {
          all[key] = safeStorage.decryptString(Buffer.from(all[key], 'base64'))
        } catch {
          // leave as-is if decryption fails
        }
      }
    }
    return all
  })
}
