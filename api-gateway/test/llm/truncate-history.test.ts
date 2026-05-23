import { describe, expect, test } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  truncateHistoryByChars,
  CHAT_HISTORY_CHAR_BUDGET,
} from '../../src/llm/truncate-history'

function msg(role: 'user' | 'assistant', content: string): Anthropic.MessageParam {
  return { role, content }
}

describe('truncateHistoryByChars', () => {
  test('under budget: returns input unchanged', () => {
    const history = [
      msg('user', 'hi'),
      msg('assistant', 'hello'),
      msg('user', 'how are you'),
    ]
    expect(truncateHistoryByChars(history, 1000)).toEqual(history)
  })

  test('over budget: drops oldest user/assistant pair', () => {
    // 4 messages, each 100 chars. Budget 250 chars → drop the first pair.
    const big = 'x'.repeat(100)
    const history = [
      msg('user', big), // pair 1
      msg('assistant', big), // pair 1
      msg('user', big), // pair 2
      msg('assistant', big), // pair 2
      msg('user', 'current question'), // never drop
    ]
    const result = truncateHistoryByChars(history, 250)
    // After dropping pair 1 (200 chars), remaining = 2 pair + current = 216 chars ≤ 250.
    expect(result.map((m) => m.content)).toEqual([big, big, 'current question'])
  })

  test('drops multiple pairs until under budget', () => {
    const big = 'x'.repeat(200)
    const history = [
      msg('user', big),
      msg('assistant', big),
      msg('user', big),
      msg('assistant', big),
      msg('user', big),
      msg('assistant', big),
      msg('user', 'q'),
    ]
    // Total = 1201. Budget = 250.
    // Drop pair 1 → 801. Drop pair 2 → 401. Drop pair 3 → 1. Done.
    const result = truncateHistoryByChars(history, 250)
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe('q')
  })

  test('never drops the final (current) message even if it alone exceeds budget', () => {
    // Caller is supposed to catch this via the oversize 413 pre-check;
    // this test asserts the helper doesn't accidentally do something
    // worse like returning [] or panicking.
    const big = 'x'.repeat(500)
    const history = [
      msg('user', 'old'),
      msg('assistant', 'old reply'),
      msg('user', big),
    ]
    const result = truncateHistoryByChars(history, 100)
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe(big)
  })

  test('single-message input: returns unchanged regardless of budget', () => {
    const history = [msg('user', 'x'.repeat(1000))]
    expect(truncateHistoryByChars(history, 50)).toEqual(history)
  })

  test('handles text-block content shape (not just strings)', () => {
    const blockContent: Anthropic.MessageParam['content'] = [
      { type: 'text', text: 'x'.repeat(200) },
    ]
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: blockContent },
      { role: 'assistant', content: blockContent },
      { role: 'user', content: 'q' },
    ]
    const result = truncateHistoryByChars(history, 100)
    // Total 401 chars > 100; drop pair 1 → [current]
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe('q')
  })

  test('CHAT_HISTORY_CHAR_BUDGET exports a sensible default', () => {
    expect(CHAT_HISTORY_CHAR_BUDGET).toBeGreaterThanOrEqual(100_000)
    expect(CHAT_HISTORY_CHAR_BUDGET).toBeLessThanOrEqual(200_000)
  })
})
