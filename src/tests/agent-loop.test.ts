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

  it('emits tool_error on Zod validation failure and continues the loop (recoverable terminal validation)', async () => {
    // Pre-PR behavior was: terminal Zod failure → finalize('failed',
    // 'TerminalValidation'). Now the loop pushes a tool_result(is_error:true)
    // and continues so the model can correct. With only one malformed
    // response scripted, the loop exhausts and ends in cap_exceeded.
    const client = buildScriptedClient([
      buildFinalToolCallResponse({
        toolName: 'submit_memo', toolUseId: 'tu1',
        toolInput: { markdown: '', evidence: [] }, // empty markdown rejected by Zod
      }),
    ])
    const opts = makeOpts(client, [makeSubmitMemoTool()])
    opts.limits = { iterations: 2, webSearches: 3, inputTokens: 100_000 }
    const result = await runAgentLoop(opts)
    // tool_error fired on the malformed terminal call.
    expect(opts.events.some(e => e.type === 'tool_error')).toBe(true)
    // Loop continued past iteration 1; either next script call returned
    // undefined (the scripted client behavior) and bubbled as an error, or
    // the iteration cap fired. Both are acceptable terminal states — the
    // critical invariant is NOT exiting with 'TerminalValidation' on the
    // first iteration.
    expect(result.status).not.toBe('success')
    expect(result.errorClass).not.toBe('TerminalValidation')
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

// ─── Terminal-tool validation retry & same-turn dispatch ───────────────────
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │  These tests cover the agent-loop's recoverable terminal flow:     │
//   │                                                                     │
//   │   • Happy retry — malformed terminal input → model corrects → done │
//   │   • Cap exhaustion — persistent malformation → cap_exceeded        │
//   │   • Multi-tool turn w/ terminal FAILURE — non-terminal also runs   │
//   │   • Multi-tool turn w/ terminal SUCCESS — side-effect tools commit │
//   │                                                                     │
//   │  Background: before this PR, terminal Zod failure exited the run    │
//   │  immediately (no retry); now it pushes a tool_result(is_error: true)│
//   │  and continues so the model can correct. Bounded by maxIterations.  │
//   └────────────────────────────────────────────────────────────────────┘

/**
 * A submit_memo variant with a stricter inner schema that mirrors the real
 * EvidenceRowSchema's web→sourceUrl rule, so retry tests can deterministically
 * trigger Zod validation failure on a missing sourceUrl.
 */
function makeStrictSubmitMemoTool() {
  return defineTool({
    name: SUBMIT_MEMO.name,
    description: 'Submit the final memo (strict evidence schema)',
    input: z
      .object({
        markdown: z.string().min(1),
        evidence: z
          .array(
            z.object({
              claimText: z.string(),
              sourceType: z.enum(['web', 'meeting']),
              sourceUrl: z.string().optional(),
              sourceId: z.string().optional(),
            }),
          )
          .default([]),
      })
      .superRefine((val, ctx) => {
        val.evidence.forEach((row, i) => {
          if (row.sourceType === 'web' && !row.sourceUrl) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['evidence', i, 'sourceUrl'],
              message: 'web evidence requires a sourceUrl',
            })
          }
        })
      }),
    terminal: true,
    handler: () => ({ ok: true }),
  })
}

describe('runAgentLoop — recoverable terminal-tool validation', () => {
  it('retries the loop when terminal Zod validation fails, then succeeds on the corrected call', async () => {
    const client = buildScriptedClient([
      // Iter 1: malformed evidence row (web sourceType, no sourceUrl).
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu-bad',
        toolInput: {
          markdown: '# Memo',
          evidence: [{ claimText: 'broken', sourceType: 'web' }],
        },
      }),
      // Iter 2: corrected — adds the missing sourceUrl.
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu-fixed',
        toolInput: {
          markdown: '# Memo',
          evidence: [
            { claimText: 'fixed', sourceType: 'web', sourceUrl: 'https://example.com' },
          ],
        },
      }),
    ])
    const opts = makeOpts(client, [makeStrictSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.iterations).toBe(2)
    // tool_error fired on the first (malformed) attempt.
    const toolErrors = opts.events.filter(e => e.type === 'tool_error')
    expect(toolErrors).toHaveLength(1)
    expect((toolErrors[0] as { message: string }).message).toContain('sourceUrl')
    // Final terminal input is the corrected payload.
    expect(result.terminalToolInput).toMatchObject({
      evidence: [{ claimText: 'fixed', sourceUrl: 'https://example.com' }],
    })
  })

  it('exits with cap_exceeded when the model keeps producing malformed terminal input', async () => {
    // Iteration cap = 3; model returns malformed every time.
    const malformedResponses = Array.from({ length: 10 }, (_, i) =>
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: `tu-bad-${i}`,
        toolInput: {
          markdown: '# Memo',
          evidence: [{ claimText: 'broken', sourceType: 'web' }],
        },
      }),
    )
    const client = buildScriptedClient(malformedResponses)
    const opts = makeOpts(client, [makeStrictSubmitMemoTool()])
    opts.limits = { iterations: 3, webSearches: 3, inputTokens: 100_000 }
    const result = await runAgentLoop(opts)
    // The loop bounded by iterations cap fires cap_exceeded eventually.
    expect(['cap_exceeded', 'failed']).toContain(result.status)
    // Each iteration emits a tool_error on the malformed terminal call.
    const toolErrors = opts.events.filter(e => e.type === 'tool_error')
    expect(toolErrors.length).toBeGreaterThanOrEqual(2)
    // Never finalized as success.
    expect(opts.events.find(e => e.type === 'done')).toBeUndefined()
  })

  it('on terminal FAILURE, also dispatches same-turn non-terminal tool_uses', async () => {
    // The model issues web_search + a malformed submit_memo in the same turn.
    // The loop must dispatch web_search (so Anthropic gets a complete set of
    // tool_results) and continue with both results in the next user turn.
    let webSearchCallCount = 0
    const webSearch = defineTool({
      name: 'web_search',
      description: 'Search the web',
      category: 'web',
      input: z.object({ query: z.string() }),
      handler: ({ query }) => {
        webSearchCallCount += 1
        return { query, results: [{ url: 'https://e.com', snippet: 'x' }] }
      },
    })
    const client = buildScriptedClient([
      // Iter 1: web_search + malformed submit_memo in the same response.
      buildToolUseResponse({
        toolCalls: [
          { id: 'tu-search', name: 'web_search', input: { query: 'gartner' } },
          {
            id: 'tu-bad',
            name: 'submit_memo',
            input: {
              markdown: '# Memo',
              evidence: [{ claimText: 'broken', sourceType: 'web' }],
            },
          },
        ],
      }),
      // Iter 2: model corrects.
      buildFinalToolCallResponse({
        toolName: 'submit_memo',
        toolUseId: 'tu-fixed',
        toolInput: {
          markdown: '# Memo',
          evidence: [
            { claimText: 'fixed', sourceType: 'web', sourceUrl: 'https://e.com' },
          ],
        },
      }),
    ])
    const opts = makeOpts(client, [webSearch, makeStrictSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    // web_search ran exactly once during the failure path.
    expect(webSearchCallCount).toBe(1)
  })

  it('on terminal SUCCESS, dispatches any same-turn non-terminal tool_uses BEFORE returning (latent-bug regression guard)', async () => {
    // The model issues cite_source + valid submit_memo in the same turn.
    // Today (pre-fix) cite_source would be dropped. After the fix, its handler
    // is called so side effects commit.
    let citeSourceCallCount = 0
    const citeSource = defineTool({
      name: 'cite_source',
      description: 'Record evidence (side-effect tool)',
      input: z.object({ claim: z.string(), url: z.string() }),
      handler: ({ claim }) => {
        citeSourceCallCount += 1
        return { ok: true, claim }
      },
    })
    const client = buildScriptedClient([
      buildToolUseResponse({
        toolCalls: [
          { id: 'tu-cite', name: 'cite_source', input: { claim: 'TAM is $50B', url: 'https://gartner.com/x' } },
          {
            id: 'tu-final',
            name: 'submit_memo',
            input: {
              markdown: '# Memo',
              evidence: [
                { claimText: 'TAM is $50B', sourceType: 'web', sourceUrl: 'https://gartner.com/x' },
              ],
            },
          },
        ],
      }),
    ])
    const opts = makeOpts(client, [citeSource, makeStrictSubmitMemoTool()])
    const result = await runAgentLoop(opts)
    expect(result.status).toBe('success')
    expect(result.iterations).toBe(1)
    // The side-effect tool ran — closes the latent bug surfaced in eng-review.
    expect(citeSourceCallCount).toBe(1)
  })
})
