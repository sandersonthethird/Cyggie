/**
 * Unit tests for the one-shot dev credential migrations.
 *
 * The migration pattern (shared between v1 OAuth tokens and v2 AI API keys)
 * is gated by USE_SAFE_STORAGE: in prod, safeStorage is used and the wipe is
 * a no-op; in dev, encrypted blobs from before the switch must be deleted so
 * the next storeCredential writes plaintext.
 *
 * Test coverage (T1–T5 from the plan-eng-review diagram):
 *   T1  dev mode, marker unset, all 5 keys absent       → no deletes; marker set
 *   T2  dev mode, marker unset, all 5 keys present      → all 5 deleted; marker set; log "wiped 5"
 *   T3  dev mode, marker already set                    → no deletes regardless of state
 *   T4  prod mode                                        → no deletes; marker not touched
 *   T5  dev mode, OAuth + unrelated keys also present   → only the API-key list is wiped
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// In-memory replacement for the settings repo. Created fresh in beforeEach
// so each test starts from a clean state.
let store: Map<string, string>
const mockGetSetting = vi.fn((key: string): string | null => store.get(key) ?? null)
const mockSetSetting = vi.fn((key: string, value: string): void => {
  store.set(key, value)
})
const mockDeleteSetting = vi.fn((key: string): void => {
  store.delete(key)
})

vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: (key: string) => mockDeleteSetting(key),
}))

// credentials.ts imports safeStorage from electron at module scope. The
// migration functions themselves don't call it, but the import must resolve.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

const {
  migrateLegacyEncryptedCredentials,
  migrateLegacyEncryptedApiKeys,
  _setUseSafeStorageForTesting,
} = await import('../main/security/credentials')

const API_KEY_MARKER = 'credentials_dev_apikey_migration_done'
const OAUTH_MARKER = 'credentials_dev_migration_done'
const API_KEYS = [
  'deepgramApiKey',
  'claudeApiKey',
  'webShareApiKey',
  'exaApiKey',
  'openAiApiKey',
] as const

beforeEach(() => {
  store = new Map()
  mockGetSetting.mockClear()
  mockSetSetting.mockClear()
  mockDeleteSetting.mockClear()
  _setUseSafeStorageForTesting(false) // default: dev mode
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('migrateLegacyEncryptedApiKeys', () => {
  test('T1: dev mode, marker unset, all 5 keys absent — no deletes, marker set, no log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    migrateLegacyEncryptedApiKeys()

    expect(mockDeleteSetting).not.toHaveBeenCalled()
    expect(store.get(API_KEY_MARKER)).toBe('1')
    expect(logSpy).not.toHaveBeenCalled()
  })

  test('T2: dev mode, marker unset, all 5 keys present — wipes all 5, marker set, logs "wiped 5"', () => {
    for (const key of API_KEYS) store.set(key, 'junk-base64-blob+=')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    migrateLegacyEncryptedApiKeys()

    for (const key of API_KEYS) {
      expect(mockDeleteSetting).toHaveBeenCalledWith(key)
      expect(store.has(key)).toBe(false)
    }
    expect(mockDeleteSetting).toHaveBeenCalledTimes(5)
    expect(store.get(API_KEY_MARKER)).toBe('1')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('wiped 5'),
    )
  })

  test('T3: dev mode, marker already set — no deletes regardless of key state', () => {
    store.set(API_KEY_MARKER, '1')
    for (const key of API_KEYS) store.set(key, 'junk-blob')

    migrateLegacyEncryptedApiKeys()

    expect(mockDeleteSetting).not.toHaveBeenCalled()
    // Keys remain untouched — marker short-circuited the loop.
    for (const key of API_KEYS) {
      expect(store.get(key)).toBe('junk-blob')
    }
  })

  test('T4: prod mode (USE_SAFE_STORAGE=true) — no deletes, marker not touched', () => {
    _setUseSafeStorageForTesting(true)
    for (const key of API_KEYS) store.set(key, 'junk-blob')

    migrateLegacyEncryptedApiKeys()

    expect(mockDeleteSetting).not.toHaveBeenCalled()
    expect(store.has(API_KEY_MARKER)).toBe(false)
    // Keys remain untouched.
    for (const key of API_KEYS) {
      expect(store.get(key)).toBe('junk-blob')
    }
  })

  test('T5: dev mode, OAuth + unrelated keys present — only API-key list is wiped', () => {
    store.set('cyggie_access_token', 'fresh-plaintext-token')
    store.set('google_calendar_tokens', '{"valid":"json"}')
    store.set('userPrefs', 'unrelated-setting')
    for (const key of API_KEYS) store.set(key, 'encrypted-blob+/=')

    migrateLegacyEncryptedApiKeys()

    // API keys gone.
    for (const key of API_KEYS) expect(store.has(key)).toBe(false)
    // OAuth + unrelated untouched.
    expect(store.get('cyggie_access_token')).toBe('fresh-plaintext-token')
    expect(store.get('google_calendar_tokens')).toBe('{"valid":"json"}')
    expect(store.get('userPrefs')).toBe('unrelated-setting')
    // v1 marker NOT set — only v2 ran.
    expect(store.has(OAUTH_MARKER)).toBe(false)
    expect(store.get(API_KEY_MARKER)).toBe('1')
  })
})

describe('migrateLegacyEncryptedCredentials (v1, refactored to use shared helper)', () => {
  test('helper extraction preserved v1 behavior — wipes OAuth tokens, not API keys', () => {
    store.set('cyggie_access_token', 'old-encrypted-blob')
    store.set('google_calendar_tokens', 'old-encrypted-blob')
    store.set('deepgramApiKey', 'should-survive-v1')

    migrateLegacyEncryptedCredentials()

    expect(store.has('cyggie_access_token')).toBe(false)
    expect(store.has('google_calendar_tokens')).toBe(false)
    // v1's list doesn't include API keys; they stay until v2 runs.
    expect(store.get('deepgramApiKey')).toBe('should-survive-v1')
    expect(store.get(OAUTH_MARKER)).toBe('1')
  })
})
