import { ipcMain, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import * as settingsRepo from '../database/repositories/settings.repo'
import { backfillMeetingSummaryNotes } from '../services/meeting-notes-backfill.service'
import { getCurrentUserId } from '../security/current-user'

const ENCRYPTED_KEYS = new Set(['deepgramApiKey', 'claudeApiKey', 'openAiApiKey'])

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

  ipcMain.handle(IPC_CHANNELS.SETTINGS_TEST_LLM_KEY, async (_event, { provider, apiKey }: { provider: 'claude' | 'openai'; apiKey: string }) => {
    const trimmed = apiKey.trim()
    if (!trimmed) return { ok: false, message: 'No API key entered.' }
    try {
      if (provider === 'openai') {
        const { default: OpenAI } = await import('openai')
        const client = new OpenAI({ apiKey: trimmed })
        await client.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        })
      } else {
        const client = new Anthropic({ apiKey: trimmed })
        await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }]
        })
      }
      return { ok: true, message: 'Key is valid.' }
    } catch (err) {
      const errStr = String(err)
      try {
        const jsonMatch = errStr.match(/\{.*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          const msg: string | undefined = parsed?.error?.message
          if (msg) return { ok: false, message: msg }
        }
      } catch { /* fall through */ }
      if (errStr.includes('401') || errStr.toLowerCase().includes('invalid api key') || errStr.toLowerCase().includes('authentication')) {
        return { ok: false, message: 'Invalid API key. Please check that you copied it correctly.' }
      }
      return { ok: false, message: errStr }
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEETING_NOTES_BACKFILL, () => {
    const userId = getCurrentUserId()
    return backfillMeetingSummaryNotes(userId)
  })
}
