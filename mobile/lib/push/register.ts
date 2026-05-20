// =============================================================================
// push/register.ts — APNs device-token registration for M3 transcription-ready
// notifications.
//
// Flow:
//   1. Root layout effect calls registerForPushNotifications() once whenever
//      auth.status transitions to 'signed_in' (covers both fresh sign-in and
//      cold-start of an already-signed-in app).
//   2. We request notification permission (idempotent if already granted),
//      get the native APNs device token via Notifications.getDevicePushTokenAsync,
//      and POST it to /devices/register-push with environment=sandbox|production.
//   3. The gateway stores it on the sessions row keyed by JWT.sid; the
//      transcribe-job sends to that token when a transcript completes.
//
// Dedup: we cache the last-registered token in memory and skip re-POSTing if
// the value hasn't changed. iOS occasionally rotates push tokens; on the
// next layout-mount the new token is registered automatically.
// =============================================================================

import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { registerPushToken } from '../api/recordings'

let lastRegisteredToken: string | null = null

/**
 * Idempotent registration. Returns true if a (possibly fresh) token was
 * registered with the gateway, false on a no-op (already registered, or
 * permission denied, or running on a simulator where APNs is unavailable).
 */
export async function registerForPushNotifications(): Promise<boolean> {
  // iOS only for V1 — Android push is deferred to a future milestone.
  if (Platform.OS !== 'ios') return false

  // APNs doesn't fire on the iOS Simulator; getDevicePushTokenAsync errors
  // there. Skip to avoid noisy logs in dev.
  if (!Device.isDevice) {
    console.warn('[push] running on simulator; APNs registration skipped')
    return false
  }

  const existing = await Notifications.getPermissionsAsync()
  let granted = existing.granted || existing.ios?.status === 3 /* PROVISIONAL */
  if (!granted) {
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        // Provisional: silent notifications without an explicit ask. Useful
        // for the "transcript ready" affordance — user gets it as a quieter
        // notification first, can upgrade later via Settings.
        provideAppNotificationSettings: true,
      },
    })
    granted = requested.granted
  }
  if (!granted) {
    console.warn('[push] notification permission denied')
    return false
  }

  // getDevicePushTokenAsync returns the raw APNs token (NOT the Expo push
  // token). The gateway uses @parse/node-apn which talks to APNs directly,
  // so we want the raw form.
  const tokenResp = await Notifications.getDevicePushTokenAsync()
  if (tokenResp.type !== 'ios') return false
  const deviceToken = tokenResp.data

  if (deviceToken === lastRegisteredToken) return false

  try {
    await registerPushToken({
      deviceToken,
      environment: __DEV__ ? 'sandbox' : 'production',
    })
    lastRegisteredToken = deviceToken
    return true
  } catch (err) {
    console.warn('[push] failed to register token with gateway:', err)
    return false
  }
}

/** Test-only seam: clear the in-memory dedup cache. */
export function _resetRegisterForTesting(): void {
  lastRegisteredToken = null
}
