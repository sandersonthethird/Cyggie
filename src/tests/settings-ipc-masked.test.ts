import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock electron BEFORE importing settings.ipc so ipcMain.handle is captured
// and we can invoke each registered handler directly.
const handlerMap = new Map<string, (...args: unknown[]) => unknown>()

const safeStorageMock = {
  isEncryptionAvailable: vi.fn().mockReturnValue(true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc(${s})`, 'utf8')),
  decryptString: vi.fn((buf: Buffer) => buf.toString('utf8').replace(/^enc\(|\)$/g, '')),
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlerMap.set(channel, fn)
    },
  },
  safeStorage: safeStorageMock,
}))

// Mock the settings repo
const settingsStore: Record<string, string> = {}
vi.mock('../main/database/repositories/settings.repo', () => ({
  getSetting: (key: string): string | null => settingsStore[key] ?? null,
  setSetting: (key: string, value: string) => {
    settingsStore[key] = value
  },
  getAllSettings: (): Record<string, string> => ({ ...settingsStore }),
}))

// Mock noisy dependencies
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn().mockResolvedValue({}) }
  },
}))
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn().mockResolvedValue({}) } }
  },
}))
vi.mock('../main/services/meeting-notes-backfill.service', () => ({
  backfillMeetingSummaryNotes: vi.fn().mockResolvedValue(0),
}))
vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: vi.fn().mockReturnValue('test-user'),
}))

const { registerSettingsHandlers } = await import('../main/ipc/settings.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')
registerSettingsHandlers()

function callHandler<T = unknown>(channel: string, ...args: unknown[]): T {
  const fn = handlerMap.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}`)
  return fn(null, ...args) as T
}

beforeEach(() => {
  for (const k of Object.keys(settingsStore)) delete settingsStore[k]
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.decryptString.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function seedEncrypted(key: string, plaintext: string) {
  // Mirror what SETTINGS_SET does: encrypt then base64
  settingsStore[key] = safeStorageMock.encryptString(plaintext).toString('base64')
}

describe('settings.ipc masked-key shape', () => {
  it('SETTINGS_GET returns { configured, masked } for encrypted keys', () => {
    seedEncrypted('claudeApiKey', 'sk-ant-test-abcd')
    const v = callHandler<{ configured: boolean; masked: string }>(
      IPC_CHANNELS.SETTINGS_GET,
      'claudeApiKey'
    )
    expect(v.configured).toBe(true)
    expect(v.masked).toBe('••••abcd')
  })

  it('SETTINGS_GET returns raw value for non-encrypted keys', () => {
    settingsStore['theme'] = 'dark'
    const v = callHandler<string>(IPC_CHANNELS.SETTINGS_GET, 'theme')
    expect(v).toBe('dark')
  })

  it('SETTINGS_GET_ALL returns masked shape for every encrypted key', () => {
    seedEncrypted('claudeApiKey', 'sk-ant-aaaa1234')
    seedEncrypted('openAiApiKey', 'sk-test-wxyz')
    settingsStore['theme'] = 'light'

    const all = callHandler<Record<string, unknown>>(IPC_CHANNELS.SETTINGS_GET_ALL)
    expect(all.claudeApiKey).toEqual({ configured: true, masked: '••••1234' })
    expect(all.openAiApiKey).toEqual({ configured: true, masked: '••••wxyz' })
    expect(all.theme).toBe('light')

    // No raw key string anywhere
    const json = JSON.stringify(all)
    expect(json).not.toContain('sk-ant-aaaa1234')
    expect(json).not.toContain('sk-test-wxyz')
  })

  it('SETTINGS_GET_ALL returns UNCONFIGURED for unset encrypted keys', () => {
    const all = callHandler<Record<string, unknown>>(IPC_CHANNELS.SETTINGS_GET_ALL)
    expect(all.claudeApiKey).toEqual({ configured: false, masked: '' })
    expect(all.deepgramApiKey).toEqual({ configured: false, masked: '' })
  })

  describe('safeStorage unavailable', () => {
    beforeEach(() => safeStorageMock.isEncryptionAvailable.mockReturnValue(false))

    it('encrypted-key reads return UNCONFIGURED', () => {
      seedEncrypted('claudeApiKey', 'sk-ant-test')
      safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
      const v = callHandler<{ configured: boolean; masked: string }>(
        IPC_CHANNELS.SETTINGS_GET,
        'claudeApiKey'
      )
      expect(v).toEqual({ configured: false, masked: '' })
    })

    it('SETTINGS_SET refuses to write an encrypted key in plaintext', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(() => callHandler(IPC_CHANNELS.SETTINGS_SET, 'claudeApiKey', 'plain')).toThrow(
        /keychain unavailable/
      )
      expect(settingsStore['claudeApiKey']).toBeUndefined()
      warn.mockRestore()
    })
  })

  describe('decryptString throws', () => {
    it('encrypted-key reads return UNCONFIGURED', () => {
      seedEncrypted('claudeApiKey', 'sk-test-xxxx')
      safeStorageMock.decryptString.mockImplementationOnce(() => {
        throw new Error('decrypt failed')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const v = callHandler<{ configured: boolean; masked: string }>(
        IPC_CHANNELS.SETTINGS_GET,
        'claudeApiKey'
      )
      expect(v).toEqual({ configured: false, masked: '' })
      warn.mockRestore()
    })
  })

  describe('SETTINGS_TEST_LLM_KEY', () => {
    it('with draft apiKey, uses the draft (not the stored key)', async () => {
      seedEncrypted('claudeApiKey', 'sk-stored-aaaa')
      const result = await callHandler<{ ok: boolean }>(IPC_CHANNELS.SETTINGS_TEST_LLM_KEY, {
        provider: 'claude',
        apiKey: 'sk-draft-bbbb',
      })
      expect(result.ok).toBe(true)
      // Stored key should NOT have been decrypted (draft was used)
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    })

    it('without apiKey, decrypts stored key and tests', async () => {
      seedEncrypted('claudeApiKey', 'sk-stored-cccc')
      const result = await callHandler<{ ok: boolean }>(IPC_CHANNELS.SETTINGS_TEST_LLM_KEY, {
        provider: 'claude',
      })
      expect(result.ok).toBe(true)
      // Decrypt was called for the test path
      expect(safeStorageMock.decryptString).toHaveBeenCalled()
    })

    it('without apiKey AND nothing stored, returns ok:false', async () => {
      const result = await callHandler<{ ok: boolean; message: string }>(
        IPC_CHANNELS.SETTINGS_TEST_LLM_KEY,
        { provider: 'claude' }
      )
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/No API key/i)
    })

    it('return shape never contains the key value', async () => {
      seedEncrypted('claudeApiKey', 'sk-secret-dddd')
      const result = await callHandler<{ ok: boolean; message: string }>(
        IPC_CHANNELS.SETTINGS_TEST_LLM_KEY,
        { provider: 'claude' }
      )
      expect(JSON.stringify(result)).not.toContain('sk-secret-dddd')
    })
  })
})
