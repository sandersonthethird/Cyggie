import { describe, it, expect, beforeEach, vi } from 'vitest'

// State that the fake DB closure references. Reset in each test.
let dbState: {
  cache: Map<string, { summary: string; token_count: number }>
  cacheOverride?: (transcriptPath: string, hash: string) => { summary: string; token_count: number } | undefined
} = { cache: new Map() }

const fakeDb = {
  prepare(sql: string) {
    if (sql.includes('SELECT summary')) {
      return {
        get: (transcriptPath: string, hash: string) =>
          dbState.cacheOverride
            ? dbState.cacheOverride(transcriptPath, hash)
            : dbState.cache.get(`${transcriptPath}|${hash}`),
      }
    }
    if (sql.includes('INSERT OR REPLACE INTO transcript_summaries')) {
      return {
        run: (transcriptPath: string, hash: string, summary: string, tokenCount: number) => {
          dbState.cache.set(`${transcriptPath}|${hash}`, { summary, token_count: tokenCount })
          return { changes: 1 }
        },
      }
    }
    return { get: () => undefined, run: () => ({ changes: 0 }) }
  },
}

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => fakeDb,
}))

import {
  allocateContext,
  ContextOverflowError,
  DEFAULT_BUDGET,
  type MeetingTranscriptInput,
} from '@cyggie/services/llm/memo/context-budget'

// ─── Anthropic SDK shim ───────────────────────────────────────────────────

function fakeAnthropic(tokensFn: (text: string) => number) {
  return {
    messages: {
      countTokens: async ({ messages }: { messages: Array<{ content: string }> }) => {
        const text =
          typeof messages[0].content === 'string' ? messages[0].content : String(messages[0].content)
        return { input_tokens: tokensFn(text) }
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const USER_BUDGET =
  DEFAULT_BUDGET.recentRawTranscriptsBudgetTokens +
  DEFAULT_BUDGET.summarizedTranscriptsBudgetTokens +
  DEFAULT_BUDGET.notesAndContactsBudgetTokens +
  DEFAULT_BUDGET.systemScaffoldTokens

function makeMeeting(id: string, daysAgo: number, body = 'transcript body'): MeetingTranscriptInput {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return {
    id,
    title: `Meeting ${id}`,
    date,
    transcriptPath: `/fake/path/${id}.txt`,
    content: body,
  }
}

describe('allocateContext', () => {
  beforeEach(() => {
    dbState = { cache: new Map() }
  })

  it('returns all transcripts raw when under budget', async () => {
    const summarize = vi.fn().mockResolvedValue('SHOULD NOT BE CALLED')
    const result = await allocateContext({
      anthropic: fakeAnthropic(() => 1_000),
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1), makeMeeting('m2', 2)],
      scaffold: 'company overview',
      summarize,
    })
    expect(result.rawTranscripts).toHaveLength(2)
    expect(result.summarizedTranscripts).toHaveLength(0)
    expect(result.meta.transcriptsDisplaced).toBe(0)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('filters out meetings with empty content before counting', async () => {
    const result = await allocateContext({
      anthropic: fakeAnthropic(() => 100),
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1), { ...makeMeeting('m2', 2), content: '' }],
      scaffold: '',
      summarize: vi.fn(),
    })
    expect(result.meta.transcriptsKept).toBe(1)
  })

  it('displaces oldest transcript when over budget', async () => {
    const summarize = vi.fn().mockResolvedValue('Summary of m2')
    const tokensFn = (text: string) =>
      text.includes('OLD body') ? USER_BUDGET + 1000 : USER_BUDGET - 1000

    const result = await allocateContext({
      anthropic: fakeAnthropic(tokensFn),
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1, 'recent body'), makeMeeting('m2', 30, 'OLD body')],
      scaffold: '',
      summarize,
    })

    expect(result.meta.transcriptsDisplaced).toBe(1)
    expect(result.rawTranscripts).toHaveLength(1)
    expect(result.rawTranscripts[0].id).toBe('m1')
    expect(result.summarizedTranscripts).toHaveLength(1)
    expect(result.summarizedTranscripts[0].id).toBe('m2')
    expect(result.summarizedTranscripts[0].summary).toBe('Summary of m2')
    expect(summarize).toHaveBeenCalledOnce()
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Meeting m2', content: 'OLD body' }),
    )
  })

  it('uses cached summary on (path, hash) hit; does not call summarize', async () => {
    dbState.cacheOverride = (transcriptPath) =>
      transcriptPath === '/fake/path/m2.txt'
        ? { summary: 'CACHED summary', token_count: 100 }
        : undefined

    const summarize = vi.fn()
    const tokensFn = (text: string) =>
      text.includes('OLD body') ? USER_BUDGET + 1000 : USER_BUDGET - 1000

    const result = await allocateContext({
      anthropic: fakeAnthropic(tokensFn),
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1, 'recent body'), makeMeeting('m2', 30, 'OLD body')],
      scaffold: '',
      summarize,
    })

    expect(summarize).not.toHaveBeenCalled()
    expect(result.meta.summaryCacheHits).toBe(1)
    expect(result.meta.summaryCacheMisses).toBe(0)
    expect(result.summarizedTranscripts[0].summary).toBe('CACHED summary')
  })

  it('throws ContextOverflowError when still over ceiling after all displacements', async () => {
    await expect(
      allocateContext({
        anthropic: fakeAnthropic(() => 250_000),
        model: 'claude-sonnet-4-5',
        meetings: [makeMeeting('m1', 1), makeMeeting('m2', 30)],
        scaffold: '',
        summarize: async () => 'short summary',
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError)
  })

  it('falls back to char/4 heuristic when countTokens throws', async () => {
    const result = await allocateContext({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropic: {
        messages: {
          countTokens: async () => {
            throw new Error('boom')
          },
        },
      } as any,
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1, 'x'.repeat(40))],
      scaffold: '',
      summarize: vi.fn(),
    })
    expect(result.meta.transcriptsDisplaced).toBe(0)
  })

  it('continues run when summarize callback throws (skips that displacement)', async () => {
    const summarize = vi.fn().mockRejectedValue(new Error('haiku down'))
    const tokensFn = (text: string) =>
      text.includes('OLD body') ? USER_BUDGET + 1000 : USER_BUDGET - 1000

    const result = await allocateContext({
      anthropic: fakeAnthropic(tokensFn),
      model: 'claude-sonnet-4-5',
      meetings: [makeMeeting('m1', 1, 'recent body'), makeMeeting('m2', 30, 'OLD body')],
      scaffold: '',
      summarize,
    })

    expect(result.rawTranscripts).toHaveLength(1)
    expect(result.summarizedTranscripts).toHaveLength(0)
    expect(result.meta.transcriptsDisplaced).toBe(1)
    expect(result.meta.summaryCacheMisses).toBe(1)
  })
})

describe('ContextOverflowError', () => {
  it('carries the code and token count', () => {
    const e = new ContextOverflowError(250_000, 'reduce something')
    expect(e.code).toBe('CONTEXT_OVERFLOW')
    expect(e.tokens).toBe(250_000)
    expect(e.message).toContain('250000')
    expect(e.message).toContain('reduce something')
    expect(e.name).toBe('ContextOverflowError')
  })
})
