// HTTP smoke test for POST /slack/events (External Agents V1 slice 1).
//
// Exercises the route via app.inject:
//   1. Missing signature header → 401 SLACK_SIGNATURE_INVALID
//   2. Wrong signature → 401 SLACK_SIGNATURE_INVALID
//   3. Stale timestamp (>5 min old) → 401 SLACK_SIGNATURE_INVALID
//   4. Valid url_verification → 200 echoing challenge
//   5. Valid slash command → 200 with hello text
//   6. Valid app_mention event → 200 ack + chat.postMessage called
//   7. SLACK_BOT_TOKEN unset → app_mention still acks 200, skips post
//   8. CYGGIE_SLACK_ENABLED=false → 404 (route not registered)
//
// We mock @slack/web-api so the test never hits Slack. The signing
// verification is the production code path — we mint test signatures
// with the same signSlackRequest helper the production verifier uses.

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'
process.env['CYGGIE_SLACK_ENABLED'] = 'true'

const TEST_SIGNING_SECRET = 'slack-smoke-test-signing-secret-32-chars'
const TEST_BOT_TOKEN = 'xoxb-test-1234567890-bot-token'
process.env['SLACK_SIGNING_SECRET'] = TEST_SIGNING_SECRET
process.env['SLACK_BOT_TOKEN'] = TEST_BOT_TOKEN

// Mock @slack/web-api BEFORE we import buildApp so the route's lazy
// client construction picks up the mock. WebClient is constructed
// in src/slack/client.ts → makeSlackClient.
const postMessageMock = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' })
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: postMessageMock },
  })),
}))

const { loadEnv } = await import('../src/env')
const { buildApp } = await import('../src/app')
const { signSlackRequest } = await import('../src/slack/signing')

let app: FastifyInstance

beforeAll(async () => {
  const env = loadEnv()
  app = await buildApp(env)
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

// Helpers ─────────────────────────────────────────────────────────────

interface InjectArgs {
  body: string
  contentType: 'application/json' | 'application/x-www-form-urlencoded'
  // Override signature / timestamp for negative tests.
  signature?: string
  timestamp?: string
  skipSig?: boolean
  skipTs?: boolean
}

async function postSlack(args: InjectArgs) {
  const timestamp = args.timestamp ?? String(Math.floor(Date.now() / 1000))
  const signature =
    args.signature ??
    signSlackRequest({
      signingSecret: TEST_SIGNING_SECRET,
      timestamp,
      rawBody: args.body,
    })
  const headers: Record<string, string> = {
    'content-type': args.contentType,
  }
  if (!args.skipSig) headers['x-slack-signature'] = signature
  if (!args.skipTs) headers['x-slack-request-timestamp'] = timestamp
  return app.inject({
    method: 'POST',
    url: '/slack/events',
    payload: args.body,
    headers,
  })
}

// Tests ───────────────────────────────────────────────────────────────

describe('POST /slack/events — auth surface', () => {
  test('rejects request without signature header', async () => {
    const res = await postSlack({
      body: '{}',
      contentType: 'application/json',
      skipSig: true,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('SLACK_SIGNATURE_INVALID')
    expect(res.json().error.message).toContain('missing_signature')
  })

  test('rejects request without timestamp header', async () => {
    const res = await postSlack({
      body: '{}',
      contentType: 'application/json',
      skipTs: true,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('SLACK_SIGNATURE_INVALID')
    expect(res.json().error.message).toContain('missing_timestamp')
  })

  test('rejects wrong signature', async () => {
    const body = '{"type":"event_callback"}'
    const ts = String(Math.floor(Date.now() / 1000))
    // Compute signature of a DIFFERENT body — payload was tampered.
    const wrongSignature = signSlackRequest({
      signingSecret: TEST_SIGNING_SECRET,
      timestamp: ts,
      rawBody: '{"different":"body"}',
    })
    const res = await postSlack({
      body,
      contentType: 'application/json',
      signature: wrongSignature,
      timestamp: ts,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.message).toContain('signature_mismatch')
  })

  test('rejects stale timestamp (>5 min old) as replay', async () => {
    const sixMinAgo = String(Math.floor(Date.now() / 1000) - 6 * 60)
    const body = '{}'
    const signature = signSlackRequest({
      signingSecret: TEST_SIGNING_SECRET,
      timestamp: sixMinAgo,
      rawBody: body,
    })
    const res = await postSlack({
      body,
      contentType: 'application/json',
      signature,
      timestamp: sixMinAgo,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.message).toContain('timestamp_too_old')
  })
})

describe('POST /slack/events — protocol surface', () => {
  test('url_verification challenge is echoed', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'abc123challenge',
    })
    const res = await postSlack({ body, contentType: 'application/json' })
    expect(res.statusCode).toBe(200)
    expect(res.json().challenge).toBe('abc123challenge')
  })

  test('bare /cyggie (empty text) returns hello inline', async () => {
    // Slice 2 introduced a slash-command dispatcher; the bare-command
    // case (no text) is what slice 1 still owns. Non-search non-empty
    // text routes to slice 5 placeholder (covered in
    // slack-search-smoke.test.ts).
    const params = new URLSearchParams({
      command: '/cyggie',
      text: '',
      user_id: 'U0123',
      channel_id: 'C0456',
      team_id: 'T0789',
    })
    const body = params.toString()
    const res = await postSlack({
      body,
      contentType: 'application/x-www-form-urlencoded',
    })
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.text).toBe("Hello! I'm Cyggie.")
  })

  test('app_mention event acks 200 and triggers chat.postMessage', async () => {
    postMessageMock.mockClear()
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U0123',
        channel: 'C0456',
        ts: '1700000000.000100',
        text: '<@U_BOT> tell me about acme',
      },
    })
    const res = await postSlack({ body, contentType: 'application/json' })
    expect(res.statusCode).toBe(200)
    // chat.postMessage runs after the ack (fire-and-forget).
    // Wait a tick for the microtask queue to flush.
    await new Promise((r) => setTimeout(r, 50))
    expect(postMessageMock).toHaveBeenCalledTimes(1)
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C0456',
        text: "Hello! I'm Cyggie.",
      }),
    )
  })

  test('DM message.im acks 200 and triggers chat.postMessage', async () => {
    postMessageMock.mockClear()
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        user: 'U0123',
        channel: 'D0456',
        ts: '1700000000.000200',
        text: 'hello cyggie',
      },
    })
    const res = await postSlack({ body, contentType: 'application/json' })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(postMessageMock).toHaveBeenCalledTimes(1)
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D0456' }),
    )
  })

  test('bot-message echoes are ignored (no infinite loop)', async () => {
    postMessageMock.mockClear()
    const body = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B0BOT',
        channel: 'D0456',
        ts: '1700000000.000300',
        text: "Hello! I'm Cyggie.",
      },
    })
    const res = await postSlack({ body, contentType: 'application/json' })
    expect(res.statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(postMessageMock).not.toHaveBeenCalled()
  })

  test('unrecognised payload acks 200 (no Slack retry storm)', async () => {
    const body = JSON.stringify({ type: 'something_unrecognised' })
    const res = await postSlack({ body, contentType: 'application/json' })
    expect(res.statusCode).toBe(200)
  })
})
