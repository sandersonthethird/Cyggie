import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  buildToolUseResponse,
  buildFinalToolCallResponse,
  buildFinalTextResponse,
  buildAnthropicError,
  buildAuthError,
  buildScriptedClient,
  resetMockIds,
} from './helpers/anthropic-mocks'
import { defineTool, z, type Tool } from '../main/llm/agents/define-tool'
import { runAgentLoop } from '../main/llm/agents/agent-loop'
import type { AgentEvent } from '../../shared/types/agent-events'

const SUBMIT_MEMO = {
  name: 'submit_memo' as const,
  input: z.object({
    markdown: z.string().min(1),
    evidence: z.array(z.object({ claimText: z.string() })).default([]),
  }),
}

function makeListMeetingsTool() {
  return defineTool({
    name: 'list_meetings',
    description: 'List meetings',
    input: z.object({}),
    handler: () => [{ id: 'm1', title: 'Pitch', date: '2026-04-12' }],
  })
}

function makeWebSearchTool() {
  return defineTool({
    name: 'web_search',
    description: 'Search the web',
    category: 'web',
    input: z.object({ query: z.string() }),
    handler: ({ query }) => ({ query, results: [{ url: 'https://e.com', snippet: 'x' }] }),
  })
}

function makeSubmitMemoTool() {
  return defineTool({
    name: SUBMIT_MEMO.name,
    description: 'Submit the final memo',
    input: SUBMIT_MEMO.input,
    terminal: true,
    handler: () => ({ ok: true }),
  })
}

function makeOpts(client: ReturnType<typeof buildScriptedClient>, tools: Tool[]) {
  const events: AgentEvent[] = []
  return {
    client,
    model: 'claude-test',
    systemPrompt: 'sys',
    initialUserMessage: 'go',
    tools,
    ctx: {
      companyId: 'co-1',
      userId: 'u-1',
      runId: 'r-1',
      signal: new AbortController().signal,
    },
    limits: { iterations: 10, webSearches: 3, inputTokens: 100_000 },
    emit: (e: AgentEvent) => events.push(e),
    signal: new AbortController().signal,
    runId: 'r-1',
    kind: 'thesis_stress_test',
    mode: 'stress_test' as const,
    companyId: 'co-1',
    pricing: { inputPerM: 3, outputPerM: 15 },
    events,
  }
}

beforeEach(() => resetMockIds())
afterEach(() => vi.useRealTimers())

describe('runAgentLoop — happy paths', () => {
  it('terminates on first turn when model calls submit_memo immediately', async () => {
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu1',
        toolInput: { markdown: '# Memo', evidence: [{ claimText: 'fast' }] },
      }),
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.iterations).toBe(1)
    expect(result.terminalToolInput).toMatchObject({ markdown: '# Memo' })
    expect(opts.events.find(e => e.type === 'done')).toBeDefined()
  })

  it('runs multi-turn: tool_use → tool_result → submit_memo', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [{ id: 'tu1', name: 'list_meetings', input: {} }],
      }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu2',
        toolInput: { markdown: '# Memo', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.iterations).toBe(2)
    expect(result.toolCallCount).toBe(1)
    expect(opts.events.filter(e => e.type === 'tool_call')).toHaveLength(1)
    expect(opts.events.filter(e => e.type === 'tool_result_summary')).toHaveLength(1)
  })

  it('emits a thinking event when text precedes tool_use', async () => {
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu1',
        toolInput: { markdown: '# Memo', evidence: [] },
        thinkingText: 'Let me research before writing the memo.',
      }),
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    await runAgentLoop(opts)
    const thinking = opts.events.find(e => e.type === 'thinking')
    expect(thinking).toBeDefined()
    if (thinking?.type === 'thinking') {
      expect(thinking.text).toContain('research before writing')
    }
  })

  it('tracks usage and computes cost estimate', async () => {
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu1',
        toolInput: { markdown: '# M', evidence: [] },
        usage: { input_tokens: 100_000, output_tokens: 1000 },
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.inputTokensTotal).toBe(100_000)
    expect(result.outputTokensTotal).toBe(1000)
    // 100k * 3 / 1M + 1k * 15 / 1M = 0.3 + 0.015 = 0.315
    expect(result.costEstimateUsd).toBeCloseTo(0.315, 3)
  })
})

describe('runAgentLoop — caps', () => {
  it('returns cap_exceeded when input_tokens cap is reached pre-call', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [{ id: 'tu1', name: 'list_meetings', input: {} }],
        usage: { input_tokens: 200_000, output_tokens: 500 },
      }),
      // shouldn't be called — but provide a fallback to surface the bug if it is
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tuX', toolInput: { markdown: '#', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    opts.limits.inputTokens = 100_000   // first turn already exceeds
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('cap_exceeded')
    expect(opts.events.find(e => e.type === 'cap_exceeded' && e.cap === 'input_tokens')).toBeDefined()
  })

  it('returns cap_exceeded when iteration cap is reached', async () => {
    const turns = Array.from({ length: 25 }, (_, i) =>
      buildToolUseResponse({ toolCalls: [{ id: `tu${i}`, name: 'list_meetings', input: {} }] })
    )
    const client = buildScriptedClient(turns)
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    opts.limits.iterations = 3
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('cap_exceeded')
    expect(result.iterations).toBe(3)
    expect(opts.events.find(e => e.type === 'cap_exceeded' && e.cap === 'iterations')).toBeDefined()
  })

  it('enforces web_search cap: surfaces error to model, agent continues', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [{ id: 'tu1', name: 'web_search', input: { query: 'a' } }],
      }),
      buildToolUseResponse({
        toolCalls: [{ id: 'tu2', name: 'web_search', input: { query: 'b' } }],
      }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tuFinal',
        toolInput: { markdown: '# After cap', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeWebSearchTool(), makeSubmitMemoTool()])
    opts.limits.webSearches = 1
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.webSearchCount).toBe(1)
    expect(opts.events.some(e => e.type === 'cap_exceeded' && e.cap === 'web_searches')).toBe(true)
  })
})

describe('runAgentLoop — retry policy', () => {
  it('retries once on 5xx, then succeeds', async () => {
    const client = buildScriptedClient([
      buildAnthropicError({ status: 503 }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu1',
        toolInput: { markdown: '# Memo', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
  })

  it('fails after exhausting 5xx retries (1 retry)', async () => {
    const client = buildScriptedClient([
      buildAnthropicError({ status: 500 }),
      buildAnthropicError({ status: 500 }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toMatch(/500/)
  })

  it('retries on 429 honoring Retry-After', async () => {
    vi.useFakeTimers()
    const client = buildScriptedClient([
      buildAnthropicError({ status: 429, retryAfter: '0.05' }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu1',
        toolInput: { markdown: '# Memo', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const promise = runAgentLoop(opts)
    await vi.advanceTimersByTimeAsync(60)
    const result = await promise
    expect(result.status).toBe('success')
  })

  it('fails fast on 401 without retry', async () => {
    const client = buildScriptedClient([buildAuthError()])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('AuthenticationError')
  })
})

describe('runAgentLoop — failure modes', () => {
  it('fails when model returns no tool_use blocks', async () => {
    const client = buildScriptedClient([
      buildFinalTextResponse({ text: 'Sorry, I can\'t do that.' }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('NoToolUse')
  })

  it('fails when stop_reason=max_tokens with incomplete tool_use', async () => {
    const client = buildScriptedClient([
      {
        ...buildToolUseResponse({ toolCalls: [{ id: 'tu1', name: 'list_meetings', input: {} }] }),
        stop_reason: 'max_tokens',
      } as never,
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('MaxTokensMidTool')
  })

  it('handles unknown tool name: surfaces error to model, continues loop', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [{ id: 'tu1', name: 'bogus_tool', input: {} }],
      }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu2',
        toolInput: { markdown: '# Recovered', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(opts.events.some(e => e.type === 'tool_error')).toBe(true)
  })

  it('handles malformed tool input: Zod rejects, error envelope, agent continues', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [{ id: 'tu1', name: 'web_search', input: { wrongKey: 'oops' } }],
      }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu2',
        toolInput: { markdown: '# Recovered', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeWebSearchTool(), makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(opts.events.some(e => e.type === 'tool_error')).toBe(true)
  })

  it('fails when submit_memo arguments fail Zod validation', async () => {
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu1',
        toolInput: { markdown: '', evidence: [] }, // empty markdown rejected by Zod
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('TerminalValidation')
  })

  it('takes first submit_memo call and ignores duplicates', async () => {
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [
          { id: 'tu1', name: 'submit_memo', input: { markdown: '# First', evidence: [] } },
          { id: 'tu2', name: 'submit_memo', input: { markdown: '# Second', evidence: [] } },
        ],
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.terminalToolInput).toMatchObject({ markdown: '# First' })
  })
})

describe('runAgentLoop — abort', () => {
  it('returns aborted when signal fires before first call', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu1', toolInput: { markdown: '#', evidence: [] },
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    opts.signal = controller.signal
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('aborted')
  })

  it('returns aborted when signal fires between turns', async () => {
    const controller = new AbortController()
    let turnCount = 0
    const baseClient = buildScriptedClient([
      buildToolUseResponse({ toolCalls: [{ id: 'tu1', name: 'list_meetings', input: {} }] }),
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu2', toolInput: { markdown: '#', evidence: [] },
      }),
    ])
    // Wrap client to fire abort after first call.
    const client = {
      messages: {
        create: vi.fn(async (...args: unknown[]) => {
          turnCount += 1
          if (turnCount === 1) {
            const result = await baseClient.messages.create(args[0] as never)
            controller.abort() // abort right after first turn returns
            return result
          }
          return baseClient.messages.create(args[0] as never)
        }),
      },
    } as unknown as ReturnType<typeof buildScriptedClient>
    const opts = makeOpts(client, [makeListMeetingsTool(), makeSubmitMemoTool()])
    opts.signal = controller.signal
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('aborted')
  })
})
