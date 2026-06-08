// HTTP smoke test for slice 5 — `/cyggie <NL question>` and
// `@Cyggie <NL question>` routes through cyggieAsk and posts answers
// to Slack. Both Anthropic and the Slack Web API are mocked; we
// verify the full handler wiring, async background work, and
// response_url / chat.postMessage routing.

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'
process.env['CYGGIE_SLACK_ENABLED'] = 'true'

const TEST_SIGNING_SECRET = 'slack-ask-smoke-signing-32-chars-min!'
const TEST_BOT_TOKEN = 'xoxb-test-ask-smoke-bot-token'
process.env['SLACK_SIGNING_SECRET'] = TEST_SIGNING_SECRET
process.env['SLACK_BOT_TOKEN'] = TEST_BOT_TOKEN
process.env['CYGGIE_SLACK_DEFAULT_USER_ID'] = 'test-ask-user'

// Mock Slack Web API.
const postMessageMock = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' })
const reactionsAddMock = vi.fn().mockResolvedValue({ ok: true })
const reactionsRemoveMock = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: postMessageMock },
    reactions: { add: reactionsAddMock, remove: reactionsRemoveMock },
  })),
}))

// Mock fetch so we capture POSTs to Slack response_url.
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (typeof url === 'string' && url.includes('hooks.slack.com')) {
    return new Response('ok', { status: 200 })
  }
  // Other fetch calls (anthropic, etc.) shouldn't happen here.
  return new Response('not mocked', { status: 500 })
})
globalThis.fetch = fetchMock as unknown as typeof fetch

// Mock the cyggieAsk module entirely — we test the wiring through the
// handler, not the agent loop (that's covered in cyggie-ask-unit.test.ts).
const cyggieAskMock = vi.fn()
vi.mock('../src/services/chat-agent/cyggie-ask', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/chat-agent/cyggie-ask')
  >('../src/services/chat-agent/cyggie-ask')
  return {
    ...actual,
    cyggieAsk: (args: unknown) => cyggieAskMock(args),
  }
})

// Mock resolveAnthropicKey so we don't need real user_credentials rows.
vi.mock('../src/llm/resolve-key', async () => {
  const actual = await vi.importActual<
    typeof import('../src/llm/resolve-key')
  >('../src/llm/resolve-key')
  return {
    ...actual,
    resolveAnthropicKey: vi.fn().mockResolvedValue('sk-test-key'),
  }
})

// Mock the audit buffer so we can spy on recordAuditAsync calls
// without hitting Neon. Surfaces the audit row shape per-test so we
// can assert on errorCode + ok for the post-reply failure path.
const auditCalls: Array<Record<string, unknown>> = []
vi.mock('../src/audit/buffer', async () => {
  const actual = await vi.importActual<typeof import('../src/audit/buffer')>(
    '../src/audit/buffer',
  )
  return {
    ...actual,
    recordAuditAsync: (row: Record<string, unknown>) => {
      auditCalls.push(row)
    },
    initAuditBuffer: () => ({
      start: () => {},
      shutdown: async () => {},
      record: async () => {},
      flush: async () => {},
      size: () => 0,
    }),
  }
})

const { loadEnv } = await import('../src/env')
const { buildApp } = await import('../src/app')
const { signSlackRequest } = await import('../src/slack/signing')
const { CyggieAskError } = await import('../src/services/chat-agent/cyggie-ask')

let app: FastifyInstance

beforeAll(async () => {
  const env = loadEnv()
  app = await buildApp(env)
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
})

beforeEach(() => {
  // Async background tasks from earlier tests pollute mock call counts;
  // reset every test so per-test expectations are about THIS test only.
  cyggieAskMock.mockReset()
  postMessageMock.mockReset().mockResolvedValue({ ok: true, ts: '1.0' })
  reactionsAddMock.mockReset().mockResolvedValue({ ok: true })
  reactionsRemoveMock.mockReset().mockResolvedValue({ ok: true })
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('hooks.slack.com')) {
      return new Response('ok', { status: 200 })
    }
    return new Response('not mocked', { status: 500 })
  })
  auditCalls.length = 0
})

// Helpers ─────────────────────────────────────────────────────────────

// Poll until predicate or timeout. Used for assertions on async
// background work (slice 6 thread-session lookup + slice 7 user-mapping
// lookup add real Neon roundtrips between the route ack and the
// cyggieAsk spy firing).
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function postSlash(text: string, responseUrl = 'https://hooks.slack.com/commands/T_TEST/12345/abc') {
  const params = new URLSearchParams({
    command: '/cyggie',
    text,
    user_id: 'U_TEST',
    channel_id: 'C_TEST',
    team_id: 'T_TEST',
    response_url: responseUrl,
  })
  const body = params.toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signSlackRequest({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp,
    rawBody: body,
  })
  return app.inject({
    method: 'POST',
    url: '/slack/events',
    payload: body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
  })
}

async function postAppMention(text: string, channel = 'C_TEST') {
  const body = JSON.stringify({
    type: 'event_callback',
    event: {
      type: 'app_mention',
      user: 'U_TEST',
      channel,
      text: `<@U_BOT> ${text}`,
      ts: '1700000000.000100',
    },
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = signSlackRequest({
    signingSecret: TEST_SIGNING_SECRET,
    timestamp,
    rawBody: body,
  })
  return app.inject({
    method: 'POST',
    url: '/slack/events',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
    },
  })
}

// Tests ───────────────────────────────────────────────────────────────

describe('POST /slack/events — slash NL Q&A (slice 5)', () => {
  test('NL question acks with placeholder + posts answer to response_url', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: '**Acme** raised **$12.5M** Series A.',
      iterationCount: 2,
      durationMs: 1200,
      usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0 },
    })
    postMessageMock.mockClear()
    fetchMock.mockClear()

    const res = await postSlash('how much did Acme raise?')
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.text).toBe(":thinking_face: Looking that up...")
    expect(reply.mrkdwn).toBe(true)

    // Wait for the async background task to run + POST to response_url.
    await new Promise((r) => setTimeout(r, 50))
    expect(cyggieAskMock).toHaveBeenCalledTimes(1)
    expect(cyggieAskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'how much did Acme raise?',
        userId: 'test-ask-user',
        caller: 'slack',
      }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const fetchUrl = fetchMock.mock.calls[0][0]
    expect(String(fetchUrl)).toContain('hooks.slack.com')
    const fetchBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(fetchBody.replace_original).toBe(true)
    expect(fetchBody.mrkdwn).toBe(true)
    // The mrkdwn converter ran: **bold** became Slack *bold*.
    expect(fetchBody.text).toContain('*Acme*')
    expect(fetchBody.text).toContain('*$12.5M*')
    expect(fetchBody.text).not.toContain('**')
  })

  test('CyggieAskError → categorized user-friendly message', async () => {
    cyggieAskMock.mockRejectedValueOnce(
      new CyggieAskError({
        code: 'RATE_LIMITED',
        message: 'anthropic 429',
      }),
    )
    fetchMock.mockClear()

    const res = await postSlash('a question')
    expect(res.statusCode).toBe(200)
    // Reply was placeholder.
    expect(res.json().text).toBe(":thinking_face: Looking that up...")

    // Async POSTed the categorized error.
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text).toMatch(/overloaded.*try again in a moment/i)
  })

  test('60s timeout error → friendly "took too long" message', async () => {
    cyggieAskMock.mockRejectedValueOnce(
      new CyggieAskError({ code: 'TIMEOUT', message: 'wall-clock cap' }),
    )
    fetchMock.mockClear()

    await postSlash('a slow question')
    await new Promise((r) => setTimeout(r, 50))
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text).toMatch(/took longer than expected/i)
    expect(body.text).toMatch(/60s/)
  })

  test('content refusal → "can\'t answer that question" message', async () => {
    cyggieAskMock.mockRejectedValueOnce(
      new CyggieAskError({
        code: 'CONTENT_REFUSED',
        message: 'refused',
      }),
    )
    fetchMock.mockClear()

    await postSlash('something forbidden')
    await new Promise((r) => setTimeout(r, 50))
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text).toMatch(/can't answer that question/i)
    expect(body.text).toMatch(/content policy/i)
  })

  test('empty answer from cyggieAsk → placeholder italic message', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: '',
      iterationCount: 1,
      durationMs: 100,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    })
    fetchMock.mockClear()

    await postSlash('something')
    await new Promise((r) => setTimeout(r, 50))
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.text).toContain('_(Cyggie returned an empty answer)_')
  })

  test('cyggieAsk success but response_url POST 500 → audit row marks SLACK_POST_FAILED (not generic INTERNAL)', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Acme raised $12.5M.',
      iterationCount: 2,
      durationMs: 800,
      usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 0 },
    })
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('hooks.slack.com')) {
        return new Response('boom', { status: 500 })
      }
      return new Response('not mocked', { status: 500 })
    })

    await postSlash('how much did Acme raise?')
    await waitFor(() => auditCalls.length >= 1, 3000)

    // Exactly one audit row, and it distinguishes the failing layer:
    // the ask succeeded but the post-back to Slack failed.
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      ok: false,
      errorCode: 'SLACK_POST_FAILED',
      surface: 'slack',
      toolName: 'cyggie_ask',
    })
    // outputSize is populated from the mrkdwn we tried to post — proves
    // the ask actually completed before the post failed.
    expect(typeof auditCalls[0]['outputSize']).toBe('number')
    expect(auditCalls[0]['outputSize'] as number).toBeGreaterThan(0)
  })

  test('cyggieAsk success + response_url POST 200 → audit row ok=true', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Jane is the CEO.',
      iterationCount: 1,
      durationMs: 200,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 },
    })

    await postSlash('who is the CEO?')
    await waitFor(() => auditCalls.length >= 1, 3000)

    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]).toMatchObject({
      ok: true,
      surface: 'slack',
      toolName: 'cyggie_ask',
    })
    expect(auditCalls[0]['errorCode']).toBeUndefined()
  })
})

describe('POST /slack/events — app_mention NL Q&A (slice 5)', () => {
  test('app_mention with question acks 200 + posts answer via chat.postMessage', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Jane is the CEO at Acme.',
      iterationCount: 1,
      durationMs: 800,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
    })
    postMessageMock.mockClear()
    fetchMock.mockClear()

    const res = await postAppMention('who is the CEO of Acme?')
    expect(res.statusCode).toBe(200)

    // App_mention path runs through slice 6 + 7 background work
    // (thread-session find-or-create + user-mapping lookup) before
    // cyggieAsk fires. Both await real Neon roundtrips; the 50ms wait
    // that worked for the slash path isn't enough here.
    await waitFor(() => cyggieAskMock.mock.calls.length >= 1, 3000)
    expect(cyggieAskMock).toHaveBeenCalledTimes(1)
    // Note: leading <@U_BOT> mention was stripped before passing to cyggieAsk.
    expect(cyggieAskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'who is the CEO of Acme?',
      }),
    )
    // Slack Web API received the answer (not the response_url path).
    expect(postMessageMock).toHaveBeenCalledTimes(1)
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_TEST',
        text: 'Jane is the CEO at Acme.',
      }),
    )
    // No response_url POST for events.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('bare @-mention with no question still posts hello (slice 1 behavior)', async () => {
    cyggieAskMock.mockClear()
    postMessageMock.mockClear()

    await postAppMention('') // text = '<@U_BOT>' only
    await new Promise((r) => setTimeout(r, 50))
    expect(cyggieAskMock).not.toHaveBeenCalled()
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello! I'm Cyggie." }),
    )
  })
})

describe('POST /slack/events — "Cyggie is working" reaction indicator', () => {
  test('app_mention adds 👀 on the message then removes it after answering', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Jane is the CEO.',
      iterationCount: 1,
      durationMs: 200,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 },
    })

    await postAppMention('who is the CEO?')
    await waitFor(() => reactionsRemoveMock.mock.calls.length >= 1, 3000)

    expect(reactionsAddMock).toHaveBeenCalledTimes(1)
    expect(reactionsAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_TEST',
        timestamp: '1700000000.000100',
        name: 'eyes',
      }),
    )
    // Removed with the same coordinates once the answer posted.
    expect(reactionsRemoveMock).toHaveBeenCalledTimes(1)
    expect(reactionsRemoveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_TEST',
        timestamp: '1700000000.000100',
        name: 'eyes',
      }),
    )
    expect(postMessageMock).toHaveBeenCalledTimes(1)
  })

  test('reaction is still removed when cyggieAsk throws', async () => {
    cyggieAskMock.mockRejectedValueOnce(
      new CyggieAskError({ code: 'INTERNAL', message: 'boom' }),
    )

    await postAppMention('a question that errors')
    await waitFor(() => reactionsRemoveMock.mock.calls.length >= 1, 3000)

    expect(reactionsAddMock).toHaveBeenCalledTimes(1)
    expect(reactionsRemoveMock).toHaveBeenCalledTimes(1)
  })

  test('missing reactions:write scope degrades silently — answer still posts', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Acme raised $12.5M.',
      iterationCount: 1,
      durationMs: 200,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 },
    })
    // Slack rejects add with missing_scope; the client wrapper swallows it.
    reactionsAddMock.mockRejectedValueOnce({ data: { error: 'missing_scope' } })

    await postAppMention('how much did Acme raise?')
    await waitFor(() => postMessageMock.mock.calls.length >= 1, 3000)

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Acme raised $12.5M.' }),
    )
    // Add was attempted but reported not-placed → nothing to remove.
    expect(reactionsAddMock).toHaveBeenCalledTimes(1)
    expect(reactionsRemoveMock).not.toHaveBeenCalled()
  })

  test('slash command does NOT use reactions (keeps placeholder UX)', async () => {
    cyggieAskMock.mockResolvedValueOnce({
      answer: 'Acme raised $12.5M.',
      iterationCount: 1,
      durationMs: 200,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 },
    })

    await postSlash('how much did Acme raise?')
    await waitFor(() => fetchMock.mock.calls.length >= 1, 3000)
    // Give any stray async reaction work a beat to (not) fire.
    await new Promise((r) => setTimeout(r, 50))

    expect(reactionsAddMock).not.toHaveBeenCalled()
    expect(reactionsRemoveMock).not.toHaveBeenCalled()
  })
})
