// Slack request signature verification (External Agents V1 slice 1).
//
// Every Slack POST to /slack/events carries:
//   X-Slack-Request-Timestamp: <unix-epoch-seconds>
//   X-Slack-Signature:         v0=<hex-sha256-hmac>
//
// The HMAC is computed as `HMAC-SHA256(signing_secret, "v0:" + ts + ":" + raw_body)`.
// We MUST verify before parsing the body — a forged JSON payload could
// otherwise be evaluated by V8's parser. The route configures a
// custom content-type parser that captures the raw body string into
// `req.slackRawBody` before this function runs.
//
// Timestamp window: Slack documents a 5-minute replay window. Anything
// outside that window is rejected even if the signature would verify;
// this defends against captured-and-replayed legit requests.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SLACK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000

export type VerifySlackReason =
  | 'missing_timestamp'
  | 'missing_signature'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'signature_mismatch'

export interface VerifySlackArgs {
  signingSecret: string
  signature: string | undefined
  timestamp: string | undefined
  rawBody: string
  // Injectable clock for testing the replay window.
  nowMs?: number
}

export type VerifySlackResult =
  | { ok: true }
  | { ok: false; reason: VerifySlackReason }

export function verifySlackSignature(
  args: VerifySlackArgs,
): VerifySlackResult {
  const { signingSecret, signature, timestamp, rawBody } = args
  const nowMs = args.nowMs ?? Date.now()

  if (!timestamp) {
    return { ok: false, reason: 'missing_timestamp' }
  }
  if (!signature) {
    return { ok: false, reason: 'missing_signature' }
  }

  const tsSeconds = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(tsSeconds)) {
    return { ok: false, reason: 'missing_timestamp' }
  }
  const tsMs = tsSeconds * 1000
  if (nowMs - tsMs > SLACK_TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_too_old' }
  }
  if (tsMs - nowMs > SLACK_TIMESTAMP_WINDOW_MS) {
    // A timestamp meaningfully in the future is also rejected — either
    // a clock-skew issue we want to surface or a tampered payload.
    return { ok: false, reason: 'timestamp_in_future' }
  }

  const base = `v0:${timestamp}:${rawBody}`
  const expected =
    'v0=' +
    createHmac('sha256', signingSecret).update(base).digest('hex')

  // Constant-time compare. Lengths must match first — timingSafeEqual
  // throws on length mismatch and that would itself leak length info via
  // the throw path.
  if (signature.length !== expected.length) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  if (
    !timingSafeEqual(
      Buffer.from(signature, 'utf-8'),
      Buffer.from(expected, 'utf-8'),
    )
  ) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  return { ok: true }
}

// Helper for tests + ngrok-tunnel smoke tooling: produce a valid Slack
// signature for a given body + timestamp. Lives in the production
// module (not test-only) so the same code path that signs in dev tools
// is the one we trust for verification.
export function signSlackRequest(args: {
  signingSecret: string
  timestamp: string
  rawBody: string
}): string {
  const { signingSecret, timestamp, rawBody } = args
  return (
    'v0=' +
    createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex')
  )
}
