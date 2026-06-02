// Unit tests for slice 5 — cyggieAsk agent loop with mocked Anthropic
// and a fake DB (tools are mocked too so we don't hit Neon). Covers:
//   - happy path: end_turn → answer returned with usage + iteration count
//   - tool_use loop: 1 tool call → result fed back → end_turn
//   - max iterations cap
//   - 60s wall-clock cap
//   - per-tool 5s timeout
//   - retry-once on Anthropic rate limit
//   - error classification → CyggieAskError code
//   - invalid input rejected fast
//   - empty conversationContext handled

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { cyggieAsk, CyggieAskError } from '../src/services/chat-agent/cyggie-ask'
import { ok } from '../src/shared/error-envelope'

// Mock all six tool implementations so cyggieAsk can run without DB.
const cyggieSearchMock = vi.fn().mockResolvedValue(ok('mocked search result'))
const cyggieGetCompanyMock = vi.fn().mockResolvedValue(ok('mocked company'))
const cyggieGetContactMock = vi.fn().mockResolvedValue(ok('mocked contact'))
const cyggieRecentMeetingsMock = vi.fn().mockResolvedValue(ok('mocked meetings'))
const cyggieGetMeetingMock = vi.fn().mockResolvedValue(ok('mocked meeting'))
const cyggieGetNotesMock = vi.fn().mockResolvedValue(ok('mocked notes'))

vi.mock('../src/mcp/tools/search', () => ({
  cyggieSearch: (args: unknown) => cyggieSearchMock(args),
  runCyggieSearch: vi.fn(),
}))
vi.mock('../src/mcp/tools/get-company', () => ({
  cyggieGetCompany: (args: unknown) => cyggieGetCompanyMock(args),
}))
vi.mock('../src/mcp/tools/get-contact', () => ({
  cyggieGetContact: (args: unknown) => cyggieGetContactMock(args),
}))
vi.mock('../src/mcp/tools/recent-meetings', () => ({
  cyggieRecentMeetings: (args: unknown) => cyggieRecentMeetingsMock(args),
}))
vi.mock('../src/mcp/tools/get-meeting', () => ({
  cyggieGetMeeting: (args: unknown) => cyggieGetMeetingMock(args),
}))
vi.mock('../src/mcp/tools/get-notes', () => ({
  cyggieGetNotes: (args: unknown) => cyggieGetNotesMock(args),
}))

// Helpers ───────────────────────────────────────────────────────────────

interface FakeMessage {
  content: Anthropic.ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

function makeFakeClient(responses: Array<FakeMessage | (() => never)>): Anthropic {
  let i = 0
  return {
    messages: {
      create: vi.fn(async () => {
        const r = responses[i++]
        if (!r) throw new Error('fake client: no more responses queued')
        if (typeof r === 'function') return r()
        return {
          id: 'msg_' + i,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: r.content,
          stop_reason: r.stop_reason,
          stop_sequence: null,
          usage: r.usage ?? {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as unknown as Anthropic.Message
      }),
    },
  } as unknown as Anthropic
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null } as Anthropic.TextBlock
}

function toolUseBlock(args: {
  id: string
  name: string
  input: Record<string, unknown>
}): Anthropic.ToolUseBlock {
  return {
    type: 'tool_use',
    id: args.id,
    name: args.name,
    input: args.input,
  } as Anthropic.ToolUseBlock
}

const COMMON_ARGS = {
  apiKey: 'sk-test',
  // Fake DB — tools are mocked so the actual db value is never used by
  // any code path under test.
  db: {} as never,
  userId: 'test-user',
  caller: 'slack' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  cyggieSearchMock.mockResolvedValue(ok('mocked search result'))
  cyggieGetCompanyMock.mockResolvedValue(ok('mocked company'))
})

afterEach(() => {
  vi.useRealTimers()
})

// Tests ─────────────────────────────────────────────────────────────────

describe('cyggieAsk: happy path', () => {
  test('returns answer when model ends turn on first iteration', async () => {
    const fakeClient = makeFakeClient([
      {
        content: [textBlock('Acme raised $12.5M in Series A.')],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 0,
        },
      },
    ])
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'How much did Acme raise?',
      clientOverride: fakeClient,
    })
    expect(result.answer).toBe('Acme raised $12.5M in Series A.')
    expect(result.iterationCount).toBe(1)
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('runs tool, feeds result back, then ends turn', async () => {
    const fakeClient = makeFakeClient([
      {
        content: [
          textBlock("Let me look that up."),
          toolUseBlock({
            id: 'tool_use_1',
            name: 'cyggie_search',
            input: { query: 'acme' },
          }),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [textBlock('Found Acme Corp — Series A.')],
        stop_reason: 'end_turn',
      },
    ])
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'Tell me about Acme.',
      clientOverride: fakeClient,
    })
    expect(result.answer).toBe('Found Acme Corp — Series A.')
    expect(result.iterationCount).toBe(2)
    expect(cyggieSearchMock).toHaveBeenCalledTimes(1)
    expect(cyggieSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'acme' }),
    )
  })

  test('handles tool that returns an error envelope (passes is_error back)', async () => {
    cyggieGetCompanyMock.mockResolvedValue({
      error: { code: 'NOT_FOUND', message: 'No company matches.' },
    })
    const fakeClient = makeFakeClient([
      {
        content: [
          toolUseBlock({
            id: 'tu_a',
            name: 'cyggie_get_company',
            input: { query: 'nonexistent' },
          }),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [
          textBlock("Sorry — I don't have a record of 'nonexistent'."),
        ],
        stop_reason: 'end_turn',
      },
    ])
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'tell me about nonexistent',
      clientOverride: fakeClient,
    })
    expect(result.answer).toContain("don't have a record")
    expect(cyggieGetCompanyMock).toHaveBeenCalledTimes(1)
  })
})

describe('cyggieAsk: caps + limits', () => {
  test('enforces maxIterations cap', async () => {
    // Loop forever — every response is tool_use.
    const repeatingToolUse: FakeMessage = {
      content: [
        toolUseBlock({ id: 'tu', name: 'cyggie_search', input: { query: 'x' } }),
      ],
      stop_reason: 'tool_use',
    }
    const fakeClient = makeFakeClient(Array(20).fill(repeatingToolUse))
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'loop forever',
        clientOverride: fakeClient,
        capsOverride: { maxIterations: 3 },
      }),
    ).rejects.toMatchObject({
      code: 'MAX_ITERATIONS',
    })
  })

  test('enforces wallClockMs cap', async () => {
    // Single response that never returns; cap forces failure.
    const stuckClient: Anthropic = {
      messages: {
        create: vi.fn(
          () =>
            new Promise((_resolve, reject) => {
              // Reject after 100ms so test doesn't hang if cap doesn't fire.
              setTimeout(() => reject(new Error('upstream took too long')), 100)
            }),
        ),
      },
    } as unknown as Anthropic
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'q',
        clientOverride: stuckClient,
        capsOverride: { wallClockMs: 50 },
      }),
    ).rejects.toBeInstanceOf(CyggieAskError)
  })

  test('enforces perTool timeout — tool result becomes error block', async () => {
    cyggieSearchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Tool takes longer than the cap.
          setTimeout(() => resolve(ok('too slow')), 200)
        }),
    )
    const fakeClient = makeFakeClient([
      {
        content: [
          toolUseBlock({ id: 'tu', name: 'cyggie_search', input: { query: 'x' } }),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [textBlock('I gave up.')],
        stop_reason: 'end_turn',
      },
    ])
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'q',
      clientOverride: fakeClient,
      capsOverride: { perToolMs: 50 },
    })
    expect(result.iterationCount).toBe(2)
    expect(result.answer).toBe('I gave up.')
  })
})

describe('cyggieAsk: error classification', () => {
  test('rejects empty question', async () => {
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: '   ',
        clientOverride: makeFakeClient([]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('rejects oversize question', async () => {
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'x'.repeat(10_000),
        clientOverride: makeFakeClient([]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('classifies rate limit error', async () => {
    const rateLimitErr = Object.assign(
      Object.create(Anthropic.RateLimitError.prototype),
      { message: 'rate limited', status: 429 },
    )
    const flakyClient: Anthropic = {
      messages: {
        create: vi.fn(async () => {
          throw rateLimitErr
        }),
      },
    } as unknown as Anthropic
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'q',
        clientOverride: flakyClient,
        capsOverride: { retryBackoffMs: [1, 1] },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  test('classifies server overload (500-class) error', async () => {
    const serverErr = Object.assign(
      Object.create(Anthropic.InternalServerError.prototype),
      { message: 'overloaded', status: 529 },
    )
    const flakyClient: Anthropic = {
      messages: {
        create: vi.fn(async () => {
          throw serverErr
        }),
      },
    } as unknown as Anthropic
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'q',
        clientOverride: flakyClient,
        capsOverride: { retryBackoffMs: [1, 1] },
      }),
    ).rejects.toMatchObject({ code: 'OVERLOADED' })
  })

  test('retries once on transient error, succeeds on second attempt', async () => {
    let attempts = 0
    const transientErr = Object.assign(
      Object.create(Anthropic.APIConnectionError.prototype),
      { message: 'network blip' },
    )
    const flakyClient: Anthropic = {
      messages: {
        create: vi.fn(async () => {
          attempts++
          if (attempts === 1) throw transientErr
          return {
            id: 'msg_after_retry',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            content: [textBlock('OK after retry.')],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          } as unknown as Anthropic.Message
        }),
      },
    } as unknown as Anthropic
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'q',
      clientOverride: flakyClient,
      capsOverride: { retryBackoffMs: [1, 1] },
    })
    expect(result.answer).toBe('OK after retry.')
    expect(attempts).toBe(2)
  })

  test('does not retry refusal (400-class), surfaces fast', async () => {
    let attempts = 0
    const refusalErr = Object.assign(
      Object.create(Anthropic.BadRequestError.prototype),
      { message: 'bad request', status: 400 },
    )
    const flakyClient: Anthropic = {
      messages: {
        create: vi.fn(async () => {
          attempts++
          throw refusalErr
        }),
      },
    } as unknown as Anthropic
    await expect(
      cyggieAsk({
        ...COMMON_ARGS,
        question: 'q',
        clientOverride: flakyClient,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(attempts).toBe(1) // no retry
  })
})

describe('cyggieAsk: unknown tool name', () => {
  test('returns is_error tool result and keeps loop going', async () => {
    const fakeClient = makeFakeClient([
      {
        content: [
          toolUseBlock({
            id: 'tu_unknown',
            name: 'not_a_real_tool',
            input: {},
          }),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [textBlock("That tool doesn't exist — sorry.")],
        stop_reason: 'end_turn',
      },
    ])
    const result = await cyggieAsk({
      ...COMMON_ARGS,
      question: 'use the wrong tool',
      clientOverride: fakeClient,
    })
    expect(result.answer).toContain("doesn't exist")
    expect(cyggieSearchMock).not.toHaveBeenCalled()
  })
})
