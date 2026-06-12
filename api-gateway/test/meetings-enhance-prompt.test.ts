import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Asserts the enhance route builds the {{attendees}} value from the
// meeting's `attendees` + `self_name` (calendar truth) and appends the
// authoritative-source instruction when applicable. We mock Anthropic
// to capture the prompt without making a network call.

interface CapturedCall {
  system: string
  prompt: string
}
declare global {
  // eslint-disable-next-line no-var
  var __capturedAnthropicCalls: CapturedCall[]
}
globalThis.__capturedAnthropicCalls = []

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
    constructor(msg: string = 'api error', status?: number) {
      super(msg)
      this.name = 'APIError'
      if (status !== undefined) this.status = status
    }
  }
  class Anthropic {
    messages = {
      create: async (params: {
        system: string
        messages: Array<{ role: string; content: string }>
      }) => {
        globalThis.__capturedAnthropicCalls.push({
          system: params.system,
          prompt: params.messages[0]?.content ?? '',
        })
        return {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'mocked summary' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }
      },
    }
  }
  return { default: Anthropic, APIError }
})

// Skip the real Anthropic key resolution (DB + env lookups) — we don't
// care which key flows in, only what prompt the route builds.
vi.mock('../src/llm/resolve-key', () => ({
  resolveAnthropicKey: async () => 'sk-ant-test-key',
  toGatewayErrorIfAnthropic: () => null,
}))

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { AUTHORITATIVE_ATTENDEES_INSTRUCTION } = await import(
  '../src/templates/meeting-summary-templates'
)

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-enh-prompt-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

beforeEach(() => {
  globalThis.__capturedAnthropicCalls = []
})

async function insertTestUser(displayName = 'Sandy Cass'): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function insertMeeting(opts: {
  userId: string
  attendees: string[] | null
  selfName: string | null
  speakerMap?: Record<string, string>
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'Birdwatch pitch',
    date: new Date('2026-05-26T12:00:00Z'),
    durationSeconds: 2580,
    status: 'transcribed',
    transcriptSegments: [
      { speaker: 0, text: 'Hi everyone. Andy mentioned earlier...', startTime: 0, endTime: 5 },
    ],
    speakerMap: opts.speakerMap ?? { '0': 'Speaker 0', '1': 'Speaker 1' },
    speakerCount: 2,
    attendees: opts.attendees,
    selfName: opts.selfName,
    wasImpromptu: false,
  })
  cleanup.track(schema.meetings, schema.meetings.id, id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

async function callEnhance(userId: string, meetingId: string): Promise<void> {
  const jwt = await mintJwt(userId)
  const res = await app.inject({
    method: 'POST',
    url: `/meetings/${meetingId}/enhance`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { templateId: 'vc_pitch' },
  })
  expect(res.statusCode).toBe(200)
}

describe('POST /meetings/:id/enhance — attendee prompt construction', () => {
  test('case 1: attendees + selfName → owner prefixed + authority claim', async () => {
    const userId = await insertTestUser('Sandy Cass')
    const meetingId = await insertMeeting({
      userId,
      attendees: ['Chris Rosenbaum'],
      selfName: 'Sandy Cass',
    })
    await callEnhance(userId, meetingId)
    const call = globalThis.__capturedAnthropicCalls[0]
    expect(call.prompt).toContain('Attendees: Sandy Cass (meeting owner), Chris Rosenbaum')
    expect(call.prompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  test('case 2: attendees = null → speakerMap fallback + NO authority claim', async () => {
    const userId = await insertTestUser('Sandy Cass')
    const meetingId = await insertMeeting({
      userId,
      attendees: null,
      selfName: 'Sandy Cass',
      speakerMap: { '0': 'Diarized A', '1': 'Diarized B' },
    })
    await callEnhance(userId, meetingId)
    const call = globalThis.__capturedAnthropicCalls[0]
    expect(call.prompt).toContain('Attendees: Diarized A, Diarized B')
    expect(call.prompt).not.toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  test('case 3: attendees = [] + selfName → just owner + authority claim', async () => {
    const userId = await insertTestUser('Sandy Cass')
    const meetingId = await insertMeeting({
      userId,
      attendees: [],
      selfName: 'Sandy Cass',
    })
    await callEnhance(userId, meetingId)
    const call = globalThis.__capturedAnthropicCalls[0]
    expect(call.prompt).toContain('Attendees: Sandy Cass (meeting owner)')
    expect(call.prompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  test('case 4: attendees has items, selfName=null → no fabricated owner', async () => {
    const userId = await insertTestUser('Sandy Cass')
    const meetingId = await insertMeeting({
      userId,
      attendees: ['Chris Rosenbaum'],
      selfName: null,
    })
    await callEnhance(userId, meetingId)
    const call = globalThis.__capturedAnthropicCalls[0]
    expect(call.prompt).toContain('Attendees: Chris Rosenbaum')
    expect(call.prompt).not.toContain('(meeting owner)')
    expect(call.prompt).toContain(AUTHORITATIVE_ATTENDEES_INSTRUCTION)
  })

  test('regression: prompt does NOT contain legacy "Participants: {{speakers}}" header', async () => {
    const userId = await insertTestUser('Sandy Cass')
    const meetingId = await insertMeeting({
      userId,
      attendees: ['Chris'],
      selfName: 'Sandy',
    })
    await callEnhance(userId, meetingId)
    const call = globalThis.__capturedAnthropicCalls[0]
    expect(call.prompt).not.toContain('Participants:')
    expect(call.prompt).not.toContain('{{speakers}}')
    expect(call.prompt).not.toContain('{{attendees}}')
  })
})
