// =============================================================================
// apns.ts — Apple Push Notification Service client.
//
// M3: the gateway sends a push to the recording-uploader's device when its
// transcript is ready. Token-based auth (.p8) — no certificates, no rotation
// pain. APNs HTTP/2 is wrapped by @parse/node-apn.
//
// Boot behavior:
//   • If APNS_KEY_ID + APNS_TEAM_ID + APNS_KEY_P8 + APNS_BUNDLE_ID are ALL set
//     → real provider initialized, sends fire.
//   • If any is missing → provider stays null, sends are silent no-ops + warn
//     log. This is the "Apple Developer Program not yet approved" path; mobile
//     polls instead.
//
// 410 Unregistered handling:
//   • APNs returns 410 when a device token is invalid (app uninstalled, token
//     rotated). The send call returns { failed: [{ device, status: '410' }] }.
//   • Caller (transcribe-job) cleans up the stored token from sessions row so
//     subsequent pushes for that session no-op until the app re-registers.
// =============================================================================

import apn from '@parse/node-apn'
import type { GatewayEnv } from '../env'

let provider: apn.Provider | null = null
let initialized = false

export interface ApnsClient {
  /**
   * Send a transcription-ready push to a single device token.
   * Returns the set of tokens that came back 410 Unregistered so the caller
   * can clean them up from the sessions table.
   */
  sendTranscriptionReady(args: {
    deviceToken: string
    meetingId: string
    title: string
  }): Promise<{ ok: boolean; unregistered: string[] }>

  /** Send a transcription-failed push (best-effort; never throws). */
  sendTranscriptionFailed(args: {
    deviceToken: string
    meetingId: string
  }): Promise<{ ok: boolean; unregistered: string[] }>

  /**
   * Send a transcription-complete-but-empty push (best-effort). Fires when
   * Deepgram processed the audio successfully but detected zero utterances
   * (silent recording / sub-threshold input). Distinct from "failed" so
   * the user gets a clear "no speech detected" copy instead of "retry".
   */
  sendTranscriptionEmpty(args: {
    deviceToken: string
    meetingId: string
    title: string
  }): Promise<{ ok: boolean; unregistered: string[] }>
}

export function initApnsClient(env: GatewayEnv): ApnsClient {
  if (!initialized) {
    initialized = true
    const ready =
      env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY_P8 && env.APNS_BUNDLE_ID
    if (!ready) {
      console.warn(
        '[apns] APNS_* env vars missing; push notifications disabled (mobile will poll for transcript completion instead).',
      )
    } else {
      provider = new apn.Provider({
        token: {
          key: env.APNS_KEY_P8!,
          keyId: env.APNS_KEY_ID!,
          teamId: env.APNS_TEAM_ID!,
        },
        production: env.APNS_ENV === 'production',
      })
    }
  }

  return {
    sendTranscriptionReady: ({ deviceToken, meetingId, title }) =>
      send({
        deviceToken,
        bundleId: env.APNS_BUNDLE_ID,
        title: 'Cyggie',
        body: `Your transcript for "${title}" is ready`,
        meetingId,
      }),
    sendTranscriptionFailed: ({ deviceToken, meetingId }) =>
      send({
        deviceToken,
        bundleId: env.APNS_BUNDLE_ID,
        title: 'Cyggie',
        body: 'Transcription failed. Tap to retry.',
        meetingId,
      }),
    sendTranscriptionEmpty: ({ deviceToken, meetingId, title }) =>
      send({
        deviceToken,
        bundleId: env.APNS_BUNDLE_ID,
        title: 'Cyggie',
        body: `"${title}" recorded — no speech detected.`,
        meetingId,
      }),
  }
}

async function send(args: {
  deviceToken: string
  bundleId: string | undefined
  title: string
  body: string
  meetingId: string
}): Promise<{ ok: boolean; unregistered: string[] }> {
  if (!provider || !args.bundleId) {
    // Not configured — caller should fall back to mobile polling.
    return { ok: false, unregistered: [] }
  }

  const note = new apn.Notification()
  note.topic = args.bundleId
  note.alert = { title: args.title, body: args.body }
  note.sound = 'default'
  note.payload = { meetingId: args.meetingId }
  // Default expiry: 1 hour. If APNs can't deliver in an hour, the message is
  // stale (user can pull-to-refresh in-app instead).
  note.expiry = Math.floor(Date.now() / 1000) + 3600

  try {
    const result = await provider.send(note, args.deviceToken)
    const unregistered = (result.failed ?? [])
      .filter((f) => f.status === '410' || f.response?.reason === 'Unregistered')
      .map((f) => f.device)
    if (result.failed && result.failed.length > 0) {
      console.warn(
        '[apns] send had failures:',
        result.failed.map((f) => ({ device: f.device, status: f.status, reason: f.response?.reason })),
      )
    }
    return { ok: result.sent.length > 0, unregistered }
  } catch (err) {
    console.error('[apns] send threw:', err)
    return { ok: false, unregistered: [] }
  }
}

/** Test-only seam: reset module state between cases. */
export function _resetApnsForTesting(): void {
  provider?.shutdown()
  provider = null
  initialized = false
}

/** Test-only seam: inject a fake provider. */
export function _setApnsProviderForTesting(p: apn.Provider | null): void {
  provider = p
  initialized = true
}
