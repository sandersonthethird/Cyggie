import { safeStorage } from 'electron'
import * as settingsRepo from '@cyggie/db/sqlite/repositories/settings.repo'

// In dev, the Electron binary is unsigned (or ad-hoc signed via
// @electron/rebuild), so macOS prompts for keychain access on every fresh
// signature. The prompt is a blocking OS dialog that hangs the main thread —
// renderer IPC calls park behind it and the window appears blank white.
// Production builds are properly code-signed and trust the ACL permanently,
// so prod still uses safeStorage. Dev falls through to plaintext in the
// SQLite settings table (same threat surface as the rest of the DB — both
// already live on local disk unencrypted).
//
// Mutable so the migration tests can flip dev/prod paths without having to
// stub import.meta.env (which is frozen in vitest's runtime).
let USE_SAFE_STORAGE = !import.meta.env.DEV

// Read-only accessor for other modules (e.g. settings.ipc.ts) that need to
// apply the same dev/prod gate. Function form keeps the live `let` value
// behind a single API instead of leaking the mutable binding as an export.
export function isSafeStorageActive(): boolean {
  return USE_SAFE_STORAGE
}

export function storeCredential(key: string, value: string): void {
  if (USE_SAFE_STORAGE && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value).toString('base64')
    settingsRepo.setSetting(key, encrypted)
  } else {
    settingsRepo.setSetting(key, value)
  }
}

export function getCredential(key: string): string | null {
  const value = settingsRepo.getSetting(key)
  if (!value) return null

  if (USE_SAFE_STORAGE && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}

// =============================================================================
// One-time dev migrations. Any credentials encrypted under the previous
// safeStorage path become unreadable once we stop calling decryptString in
// dev, so we wipe them on the first dev boot. The user re-auths once; a
// marker setting prevents the wipe from re-running.
//
// Two migrations, two markers — kept separate so adding a new batch of
// encrypted keys (e.g. v1 missed the AI API keys → v2) doesn't re-wipe
// freshly-plaintext credentials from prior batches that the user has
// already re-entered.
// =============================================================================

// Shared one-shot migration body. Used by both v1 (OAuth tokens) and v2 (API
// keys). When a future batch is needed, add a new list + marker + caller —
// no copying loops or marker logic.
function runOneShotKeyWipeMigration(
  markerKey: string,
  keyList: readonly string[],
  label: string,
): void {
  if (USE_SAFE_STORAGE) return
  if (settingsRepo.getSetting(markerKey) === '1') return

  let wiped = 0
  for (const key of keyList) {
    if (settingsRepo.getSetting(key) == null) continue
    // Heuristic: anything that came out of safeStorage.encryptString is binary
    // we stored as base64. We just nuke all listed keys once — the user
    // re-enters on next demand. Cheap, deterministic, idempotent via marker.
    settingsRepo.deleteSetting(key)
    wiped += 1
  }
  settingsRepo.setSetting(markerKey, '1')
  if (wiped > 0) {
    console.log(
      `[credentials] ${label}: wiped ${wiped} legacy encrypted key(s); re-enter in Settings.`,
    )
  }
}

// ─── v1: OAuth tokens (already shipped; kept here for back-compat) ───────────
const DEV_MIGRATION_MARKER = 'credentials_dev_migration_done'
const KNOWN_ENCRYPTED_KEYS = [
  // Cyggie sync auth (Phase 1.5a)
  'cyggie_access_token',
  'cyggie_refresh_token',
  'cyggie_user_id',
  'cyggie_user_email',
  // Google OAuth (calendar + gmail tokens; see calendar/google-auth.ts)
  'google_calendar_tokens',
  'google_gmail_tokens',
  'google_tokens', // legacy combined token blob
  'google_client_id',
  'google_client_secret',
  'google_calendar_granted_scopes',
  'google_gmail_granted_scopes',
  'google_granted_scopes', // legacy
  'google_calendar_account_email',
  'google_gmail_account_email',
] as const

export function migrateLegacyEncryptedCredentials(): void {
  runOneShotKeyWipeMigration(DEV_MIGRATION_MARKER, KNOWN_ENCRYPTED_KEYS, 'dev migration')
}

// ─── v2: AI API keys (v1 missed these, causing Deepgram Sec-WebSocket-Protocol
// crash) ─────────────────────────────────────────────────────────────────────
const DEV_APIKEY_MIGRATION_MARKER = 'credentials_dev_apikey_migration_done'
const KNOWN_ENCRYPTED_API_KEYS = [
  'deepgramApiKey',
  'claudeApiKey',
  'webShareApiKey', // back-compat alt for Claude
  'exaApiKey',
  'openAiApiKey',
] as const

export function migrateLegacyEncryptedApiKeys(): void {
  runOneShotKeyWipeMigration(
    DEV_APIKEY_MIGRATION_MARKER,
    KNOWN_ENCRYPTED_API_KEYS,
    'dev API key migration',
  )
}

// Test seam — flips the dev/prod gate without touching frozen import.meta.env.
// NEVER call from production code.
export function _setUseSafeStorageForTesting(value: boolean): void {
  USE_SAFE_STORAGE = value
}
