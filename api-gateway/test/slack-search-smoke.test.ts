// HTTP smoke test for `/cyggie search <q>` (External Agents V1 slice 2).
//
// Covers the slash-command dispatcher's three routing paths:
//   1. `/cyggie search <q>` with CYGGIE_SLACK_DEFAULT_USER_ID set →
//      calls runCyggieSearch + formats mrkdwn (DB-touching path).
//   2. `/cyggie search` (no query) → usage message.
//   3. `/cyggie <random text>` → "not yet wired" hint pointing at slice 5.
//   4. `/cyggie` (no text) → slice 1's hello, unchanged.
//   5. `/cyggie search ...` when CYGGIE_SLACK_DEFAULT_USER_ID is unset →
//      explicit "not yet linked" message.
//
// The full DB roundtrip (real Neon query) is only exercised when the
// test happens to have rows for the test user. This file inserts a
// single throwaway company under the configured test user and asserts
// the formatted reply contains it.

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import type { FastifyInstance } from 'fastify'
import { makeDbCleanup, type DbCleanup } from './_helpers/db-cleanup'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'
process.env['CYGGIE_SLACK_ENABLED'] = 'true'

const TEST_SIGNING_SECRET = 'slack-search-smoke-signing-32-chars-min'
const TEST_BOT_TOKEN = 'xoxb-test-1234567890-bot-token'
process.env['SLACK_SIGNING_SECRET'] = TEST_SIGNING_SECRET
process.env['SLACK_BOT_TOKEN'] = TEST_BOT_TOKEN

// Each test user id is unique so concurrent runs don't collide. Set
// before importing env so the gateway picks it up.
const TEST_USER_ID = `test-slack-search-${createId().slice(0, 8)}`
process.env['CYGGIE_SLACK_DEFAULT_USER_ID'] = TEST_USER_ID

// Mock @slack/web-api so we don't need a real Slack workspace; the
// slash command path uses synchronous JSON reply, not chat.postMessage,
// but mocking avoids a real SDK instantiation that would try to validate
// the token.
const postMessageMock = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' })
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage: postMessageMock },
  })),
}))

const { loadEnv } = await import('../src/env')
const { buildApp } = await import('../src/app')
const { signSlackRequest } = await import('../src/slack/signing')
const { getDb } = await import('../src/db')
const { schema } = await import('@cyggie/db')

let app: FastifyInstance
let env: ReturnType<typeof loadEnv>
let cleanup: DbCleanup
const TEST_PREFIX = `acme-test-${createId().slice(0, 6)}-`

beforeAll(async () => {
  env = loadEnv()
  app = await buildApp(env)
  await app.ready()

  // Seed: test user + one company with a recognizable name. The user
  // row is required because org_companies.user_id FKs to users.id.
  const db = getDb(env.GATEWAY_DATABASE_URL)
  cleanup = makeDbCleanup(db)
  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    googleSub: 'sub-' + TEST_USER_ID,
    email: `${TEST_USER_ID}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, TEST_USER_ID)
  const companyId = `co-${createId().slice(0, 12)}`
  await db.insert(schema.orgCompanies).values({
    id: companyId,
    userId: TEST_USER_ID,
    canonicalName: `${TEST_PREFIX}Acme Corp`,
    normalizedName: `${TEST_PREFIX.toLowerCase()}acme corp`,
    primaryDomain: 'acme.example',
    industry: 'AI',
    pipelineStage: 'Series A',
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)
})

afterAll(async () => {
  if (cleanup) await cleanup.cleanup()
  if (app) await app.close()
})

async function postSlash(text: string) {
  const params = new URLSearchParams({
    command: '/cyggie',
    text,
    user_id: 'U_TEST',
    channel_id: 'C_TEST',
    team_id: 'T_TEST',
    // response_url required by slice 5's NL Q&A dispatcher for the
    // async-reply path; harmless for slices 1+2's synchronous replies.
    response_url: 'https://hooks.slack.com/commands/T_TEST/12345/abc',
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

describe('POST /slack/events — slash command dispatcher (slice 2)', () => {
  test('bare /cyggie still returns slice 1 hello', async () => {
    const res = await postSlash('')
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.text).toBe("Hello! I'm Cyggie.")
  })

  test('/cyggie search (no query) — bare "search" routes to cyggieAsk (slice 5)', async () => {
    // Slice 2's dispatcher only matches `search <q>` (with a trailing
    // word). Bare `search` doesn't match → falls through to slice 5's
    // NL Q&A path, which returns the thinking-face placeholder.
    const res = await postSlash('search')
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.text).toContain('Looking that up')
  })

  test('/cyggie <random text> routes to cyggieAsk (slice 5)', async () => {
    const res = await postSlash('how much did Acme raise')
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.text).toContain('Looking that up')
  })

  test('/cyggie search <q> returns formatted mrkdwn with the seeded company', async () => {
    // Query the prefix so we get exactly our test row.
    const res = await postSlash(`search ${TEST_PREFIX}Acme`)
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('in_channel')
    expect(reply.mrkdwn).toBe(true)
    expect(reply.text).toContain('*Search results for')
    expect(reply.text).toContain('*Companies')
    expect(reply.text).toContain(`${TEST_PREFIX}Acme Corp`)
    expect(reply.text).toContain('cyggie://company/')
    expect(reply.text).toContain('AI · Series A')
    expect(reply.text).toContain('acme.example')
  })

  test('/cyggie search <q> with no matches returns "No matches"', async () => {
    const res = await postSlash('search definitely-no-such-company-xyz-zzz')
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.text).toContain('No matches')
  })
})

describe('POST /slack/events — search when CYGGIE_SLACK_DEFAULT_USER_ID unset', () => {
  // Separate app instance with the env var cleared. Stand up a fresh
  // app so the env change is honored.
  let appNoUser: FastifyInstance
  beforeAll(async () => {
    const prior = process.env['CYGGIE_SLACK_DEFAULT_USER_ID']
    delete process.env['CYGGIE_SLACK_DEFAULT_USER_ID']
    const envNoUser = loadEnv()
    appNoUser = await buildApp(envNoUser)
    await appNoUser.ready()
    // Restore so the other tests' app teardown isn't disrupted.
    if (prior) process.env['CYGGIE_SLACK_DEFAULT_USER_ID'] = prior
  })
  afterAll(async () => {
    if (appNoUser) await appNoUser.close()
  })

  test('search returns "Cyggie not yet linked" message', async () => {
    const params = new URLSearchParams({
      command: '/cyggie',
      text: 'search anything',
      user_id: 'U_TEST',
      channel_id: 'C_TEST',
      team_id: 'T_TEST',
    })
    const body = params.toString()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signSlackRequest({
      signingSecret: TEST_SIGNING_SECRET,
      timestamp,
      rawBody: body,
    })
    const res = await appNoUser.inject({
      method: 'POST',
      url: '/slack/events',
      payload: body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-signature': signature,
        'x-slack-request-timestamp': timestamp,
      },
    })
    expect(res.statusCode).toBe(200)
    const reply = res.json()
    expect(reply.response_type).toBe('ephemeral')
    expect(reply.text).toContain('not yet linked')
    expect(reply.text).toContain('CYGGIE_SLACK_DEFAULT_USER_ID')
  })
})
