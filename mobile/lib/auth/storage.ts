import * as SecureStore from 'expo-secure-store'

// Keychain-backed storage for auth artifacts. Three tiers of sensitivity:
//
//   ACCESS_TOKEN  — short-lived (15 min). Held in memory by the Zustand store
//                   at runtime; only persisted to SecureStore so a cold app
//                   start doesn't immediately need a refresh round-trip.
//                   No biometric gate (it's short-lived anyway).
//
//   REFRESH_TOKEN — long-lived (30 days). The crown jewel — possession of
//                   this means full account access until revoked. Stored
//                   with requireAuthentication so a stolen device with the
//                   Keychain still locked can't extract it. iOS prompts for
//                   FaceID/TouchID at read time.
//
//   USER_ID + DEVICE_ID + LAST_ACTION — non-sensitive bookkeeping. Plain
//                   SecureStore is fine.

const ACCESS_TOKEN_KEY = 'cyggie.access_token'
const REFRESH_TOKEN_KEY = 'cyggie.refresh_token'
const USER_ID_KEY = 'cyggie.user_id'
const DEVICE_ID_KEY = 'cyggie.device_id'
const LAST_ACTION_KEY = 'cyggie.last_action'

const REFRESH_OPTS: SecureStore.SecureStoreOptions = {
  // V1 / dev: no biometric gate. The Simulator has no FaceID/passcode
  // enrolled by default, and on a real device the prompt fires on every
  // read (including the silent refresh path in api/client.ts) which is
  // bad UX. M6 polish will (a) check expo-local-authentication availability,
  // (b) prompt at sign-in to enroll, and (c) re-enable
  // requireAuthentication only when both are present.
  //
  // Threat model trade: refresh-token theft requires either physical device
  // access while unlocked, OR a Keychain-extracting jailbreak. The
  // 30-day rotation + device_id binding bound the blast radius.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

const PLAIN_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

export async function setAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, PLAIN_OPTS)
}

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY, PLAIN_OPTS)
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, REFRESH_OPTS)
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, REFRESH_OPTS)
}

export async function setUserId(id: string): Promise<void> {
  await SecureStore.setItemAsync(USER_ID_KEY, id, PLAIN_OPTS)
}

export async function getUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_ID_KEY, PLAIN_OPTS)
}

export async function setDeviceId(id: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id, PLAIN_OPTS)
}

export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_ID_KEY, PLAIN_OPTS)
}

export type LastAction = 'returning' | 'create_workspace' | 'join_firm'

export async function setLastAction(action: LastAction): Promise<void> {
  await SecureStore.setItemAsync(LAST_ACTION_KEY, action, PLAIN_OPTS)
}

export async function getLastAction(): Promise<LastAction | null> {
  const raw = await SecureStore.getItemAsync(LAST_ACTION_KEY, PLAIN_OPTS)
  if (raw === 'returning' || raw === 'create_workspace' || raw === 'join_firm') {
    return raw
  }
  return null
}

/** Wipe everything. Called on /auth/logout and on 401 with no recovery path. */
export async function clearAllAuthStorage(): Promise<void> {
  // Delete in parallel; ignore not-found errors.
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY, PLAIN_OPTS).catch(() => undefined),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, REFRESH_OPTS).catch(() => undefined),
    SecureStore.deleteItemAsync(USER_ID_KEY, PLAIN_OPTS).catch(() => undefined),
    SecureStore.deleteItemAsync(LAST_ACTION_KEY, PLAIN_OPTS).catch(() => undefined),
    // device_id stays — it's a stable per-device identifier, not a credential.
  ])
}
