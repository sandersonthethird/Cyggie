import { safeStorage } from 'electron'
import * as settingsRepo from '../database/repositories/settings.repo'

export function storeCredential(key: string, value: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value).toString('base64')
    settingsRepo.setSetting(key, encrypted)
  } else {
    settingsRepo.setSetting(key, value)
  }
}

export function getCredential(key: string): string | null {
  const value = settingsRepo.getSetting(key)
  if (!value) return null

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}
