import { ipcMain, safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { ENCRYPTED_KEYS, UNCONFIGURED_KEY, type MaskedKey } from '../../shared/types/settings'
import * as settingsRepo from '../database/repositories/settings.repo'
import { backfillMeetingSummaryNotes } from '../services/meeting-notes-backfill.service'
import { getCurrentUserId } from '../security/current-user'

// settings.ipc.ts — read/write/test paths for AppSettings.
//
//   Read  (SETTINGS_GET, SETTINGS_GET_ALL):
//     key ∈ ENCRYPTED_KEYS  → { configured, masked: '••••' + lastFour }
//     other keys             → raw value
//     (renderer NEVER sees plaintext for encrypted keys)
//
//   Write (SETTINGS_SET):
//     renderer sends plaintext → main encrypts via safeStorage → DB stores ciphertext
//
//   Test  (SETTINGS_TEST_LLM_KEY):
//     with apiKey arg        → test that draft (renderer→main)
//     without apiKey arg     → main decrypts stored key, tests, returns {ok, message}
//                              — the decrypted key is never echoed back to the renderer
//
//   safeStorage unavailable (locked keychain, headless CI, …):
//     masked-key reads return UNCONFIGURED_KEY and a one-time warning is logged.
//     The Settings UI surfaces this via a banner so the failure is loud.

const ENCRYPTED_SET = new Set<string>(ENCRYPTED_KEYS)

let safeStorageWarned = false
function warnSafeStorageUnavailableOnce(): void {
  if (safeStorageWarned) return
  safeStorageWarned = true
  console.warn(
    '[settings.ipc] safeStorage.isEncryptionAvailable() === false — encrypted keys will appear as unconfigured to the renderer. Verify the OS keychain is reachable.'
  )
}

function maskKey(plaintext: string): MaskedKey {
  if (!plaintext) return UNCONFIGURED_KEY
  const lastFour = plaintext.length >= 4 ? plaintext.slice(-4) : plaintext
  return { configured: true, masked: `••••${lastFour}` }
}

/**
 * Decrypt a stored ciphertext to plaintext. Returns `null` if storage is empty,
 * encryption is unavailable, or decryption throws. Callers in test/use paths
 * MUST treat null as "no usable key" and never leak the raw ciphertext back to
 * the renderer.
 */
function decryptStored(rawStored: string | null): string | null {
  if (!rawStored) return null
  if (!safeStorage.isEncryptionAvailable()) {
    warnSafeStorageUnavailableOnce()
    return null
  }
  try {
    return safeStorage.decryptString(Buffer.from(rawStored, 'base64'))
  } catch (err) {
    console.warn('[settings.ipc] decryptString failed:', (err as Error).message)
    return null
  }
}

function readEncryptedAsMasked(key: string): MaskedKey {
  const raw = settingsRepo.getSetting(key)
  const plaintext = decryptStored(raw)
  return plaintext ? maskKey(plaintext) : UNCONFIGURED_KEY
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_event, key: string) => {
    if (ENCRYPTED_SET.has(key)) return readEncryptedAsMasked(key)
    return settingsRepo.getSetting(key)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, key: string, value: string) => {
    let storedValue = value
    if (ENCRYPTED_SET.has(key) && safeStorage.isEncryptionAvailable()) {
      storedValue = safeStorage.encryptString(value).toString('base64')
    } else if (ENCRYPTED_SET.has(key)) {
      // safeStorage unavailable but caller is trying to set a sensitive key —
      // refuse rather than write plaintext to disk.
      warnSafeStorageUnavailableOnce()
      throw new Error('Cannot store key — OS keychain unavailable.')
    }
    settingsRepo.setSetting(key, storedValue)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, () => {
    const all = settingsRepo.getAllSettings()
    const masked: Record<string, unknown> = { ...all }
    for (const key of ENCRYPTED_KEYS) {
      masked[key] = readEncryptedAsMasked(key)
    }
    return masked
  })

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_TEST_LLM_KEY,
    async (
      _event,
      { provider, apiKey }: { provider: 'claude' | 'openai'; apiKey?: string }
    ) => {
      const draftTrimmed = (apiKey ?? '').trim()
      let testKey = draftTrimmed
      if (!testKey) {
        const storedKey = provider === 'openai' ? 'openAiApiKey' : 'claudeApiKey'
        testKey = decryptStored(settingsRepo.getSetting(storedKey)) ?? ''
        if (!testKey) return { ok: false, message: 'No API key configured.' }
      }

      try {
        if (provider === 'openai') {
          const { default: OpenAI } = await import('openai')
          const client = new OpenAI({ apiKey: testKey })
          await client.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          })
        } else {
          const client = new Anthropic({ apiKey: testKey })
          await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'ping' }],
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
        } catch {
          /* fall through */
        }
        if (
          errStr.includes('401') ||
          errStr.toLowerCase().includes('invalid api key') ||
          errStr.toLowerCase().includes('authentication')
        ) {
          return { ok: false, message: 'Invalid API key. Please check that you copied it correctly.' }
        }
        return { ok: false, message: errStr }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEETING_NOTES_BACKFILL, () => {
    const userId = getCurrentUserId()
    return backfillMeetingSummaryNotes(userId)
  })
}

// Exported for tests in src/tests/settings-ipc-masked.test.ts
export const __test__ = { maskKey, decryptStored, readEncryptedAsMasked }
