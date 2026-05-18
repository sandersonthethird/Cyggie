import * as Crypto from 'expo-crypto'
import { getDeviceId, setDeviceId } from './storage'

// Stable per-device identifier. Generated once on first launch and persisted
// in SecureStore. The gateway uses device_id as the persistent key in the
// sessions table — re-installing the app deliberately generates a NEW id so
// the user has to re-OAuth (treated as a new device).
//
// Format: 32 random bytes, base64url-encoded — ~43 chars, well under the
// gateway's varchar(64) cap.

let cached: string | null = null

export async function getOrCreateDeviceId(): Promise<string> {
  if (cached) return cached
  const stored = await getDeviceId()
  if (stored) {
    cached = stored
    return stored
  }
  // Generate.
  const bytes = await Crypto.getRandomBytesAsync(32)
  // Base64url encode.
  const id = bytesToBase64Url(bytes)
  await setDeviceId(id)
  cached = id
  return id
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // RN doesn't have btoa on older targets but Hermes does.
  // eslint-disable-next-line no-undef
  const b64 = (globalThis as { btoa?: (s: string) => string }).btoa
    ? (globalThis as unknown as { btoa: (s: string) => string }).btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
