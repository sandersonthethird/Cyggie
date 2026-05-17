/**
 * Tests for chat-runner.ts — the shared dispatch tail that owns the single
 * AbortController, attachment injection, and provider call.
 *
 *   What this exercises:
 *     1. Single AbortController invariant: aborting kills whichever turn is
 *        in flight, regardless of which kind started it.
 *     2. injectTextAttachments inlines text, leaves images for the provider.
 *     3. userPromptPrefix / questionLabel / questionFooter compose the
 *        right wire shape (matches the per-kind templates the legacy code
 *        used).
 *     4. Provider is invoked with (systemPrompt, userPrompt, sendProgress,
 *        signal, imageAttachments).
 *     5. abortChatTurn before any send is a safe no-op.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatAttachment } from '../shared/types/chat'

// ── Provider mock — captures all five generateSummary args ─────────────

interface CapturedCall {
  system: string
  user: string
  signal: AbortSignal | undefined
  imageAtts: ChatAttachment[] | undefined
}

let capturedCalls: CapturedCall[] = []
let resolveProvider: ((s: string) => void) | null = null
let rejectProvider: ((e: Error) => void) | null = null

vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: (
      system: string,
      user: string,
      _onProgress: unknown,
      signal: AbortSignal | undefined,
      imageAtts: ChatAttachment[] | undefined
    ) => {
      capturedCalls.push({ system, user, signal, imageAtts })
      // Allow tests to control resolution timing.
      return new Promise<string>((res, rej) => {
        resolveProvider = res
        rejectProvider = rej
      })
    },
  }),
}))

vi.mock('../main/llm/send-progress', () => ({
  sendProgress: () => {},
}))

const { runChatTurn, abortChatTurn, injectTextAttachments } = await import(
  '../main/llm/chat-runner'
)

beforeEach(() => {
  capturedCalls = []
  resolveProvider = null
  rejectProvider = null
})

// ── injectTextAttachments ──────────────────────────────────────────────

describe('injectTextAttachments', () => {
  it('returns question unchanged when no text attachments', () => {
    expect(injectTextAttachments('hello', [])).toBe('hello')
    expect(injectTextAttachments('hello', [{ name: 'a.png', mimeType: 'image/png', type: 'image', data: 'b64' }])).toBe('hello')
  })

  it('inlines a single text attachment under ## Attached Files', () => {
    const out = injectTextAttachments('hello', [
      { name: 'memo.md', mimeType: 'text/markdown', type: 'text', data: 'note body' },
    ])
    expect(out).toContain('## Attached Files')
    expect(out).toContain('### memo.md')
    expect(out).toContain('note body')
  })

  it('truncates each text attachment to 50K chars', () => {
    const big = 'A'.repeat(60_000)
    const out = injectTextAttachments('q', [{ name: 'big.txt', mimeType: 'text/plain', type: 'text', data: big }])
    // The truncated payload should appear as a single uninterrupted run of
    // 50_000 'A's. Use a longest-run scan instead of /A{50000}/ — the regex
    // backtracks catastrophically and was flaky under parallel test load.
    let longest = 0
    let current = 0
    for (let i = 0; i < out.length; i++) {
      if (out[i] === 'A') {
        current += 1
        if (current > longest) longest = current
      } else {
        current = 0
      }
    }
    expect(longest).toBe(50_000)
  })

  it('separates multiple attachments with blank lines', () => {
    const out = injectTextAttachments('q', [
      { name: 'one.txt', mimeType: 'text/plain', type: 'text', data: 'one' },
      { name: 'two.txt', mimeType: 'text/plain', type: 'text', data: 'two' },
    ])
    expect(out.split('\n\n').length).toBeGreaterThan(2)
    expect(out).toContain('### one.txt')
    expect(out).toContain('### two.txt')
  })
})

// ── runChatTurn ────────────────────────────────────────────────────────

describe('runChatTurn — wire format', () => {
  it('composes userPrompt = prefix + context + ---  + questionLabel: q', async () => {
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'What about Init Labs?',
      userPromptPrefix: 'Here is the meeting information:',
      questionLabel: 'User question',
    })
    resolveProvider!('OK')
    await promise

    expect(capturedCalls[0].system).toBe('SYS')
    expect(capturedCalls[0].user).toBe(
      'Here is the meeting information:\n\nCTX\n\n---\n\nUser question: What about Init Labs?'
    )
  })

  it('appends questionFooter on a new line when provided', async () => {
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'User question',
      questionFooter: 'Please cite the meeting title.',
    })
    resolveProvider!('OK')
    await promise

    expect(capturedCalls[0].user).toMatch(/Q\?\n\nPlease cite the meeting title\.$/)
  })

  it('uses "Question" label for company/contact-style turns', async () => {
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'Question',
    })
    resolveProvider!('OK')
    await promise

    expect(capturedCalls[0].user).toContain('\n\nQuestion: Q?')
    expect(capturedCalls[0].user).not.toContain('User question')
  })

  it('inlines text attachments into the question body', async () => {
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'Question',
      attachments: [{ name: 'note.md', mimeType: 'text/markdown', type: 'text', data: 'inline content' }],
    })
    resolveProvider!('OK')
    await promise

    expect(capturedCalls[0].user).toContain('## Attached Files')
    expect(capturedCalls[0].user).toContain('inline content')
  })

  it('forwards image attachments as the 5th provider arg (not inlined)', async () => {
    const img: ChatAttachment = { name: 'screenshot.png', mimeType: 'image/png', type: 'image', data: 'b64data' }
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'Question',
      attachments: [img],
    })
    resolveProvider!('OK')
    await promise

    expect(capturedCalls[0].imageAtts).toEqual([img])
    // Image not inlined into the user prompt body.
    expect(capturedCalls[0].user).not.toContain('b64data')
  })
})

// ── Single-AbortController invariant ───────────────────────────────────

describe('runChatTurn — single AbortController invariant', () => {
  it('abortChatTurn() aborts the in-flight turn', async () => {
    const promise = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'User question',
    })

    // Capture the signal the provider received, then abort.
    const signal = capturedCalls[0].signal!
    expect(signal.aborted).toBe(false)
    abortChatTurn()
    expect(signal.aborted).toBe(true)

    // Resolve the pending provider promise so the test doesn't hang.
    resolveProvider!('OK')
    await promise
  })

  it('abortChatTurn() before any send is a safe no-op', () => {
    expect(() => abortChatTurn()).not.toThrow()
  })

  it('abort kills whichever turn is currently in flight regardless of kind', async () => {
    // First: start a "company" turn, abort it, resolve.
    const turn1 = runChatTurn({
      systemPrompt: 'COMPANY_SYS',
      context: 'company-ctx',
      question: 'pricing?',
      userPromptPrefix: 'About Init Labs:',
      questionLabel: 'Question',
    })
    const signal1 = capturedCalls[0].signal!
    abortChatTurn()
    expect(signal1.aborted).toBe(true)
    resolveProvider!('partial')
    await turn1

    // Second: start a "global" turn — independent, fresh AbortController.
    const turn2 = runChatTurn({
      systemPrompt: 'GLOBAL_SYS',
      context: 'global-ctx',
      question: 'what about Bobby Kwon?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'User question',
    })
    const signal2 = capturedCalls[1].signal!
    expect(signal2).not.toBe(signal1) // fresh controller
    expect(signal2.aborted).toBe(false)
    abortChatTurn() // should kill turn2's signal, not re-fire turn1's
    expect(signal2.aborted).toBe(true)
    resolveProvider!('partial-2')
    await turn2
  })

  it('clears the active controller on resolve so a stale abort is a no-op', async () => {
    const turn = runChatTurn({
      systemPrompt: 'SYS',
      context: 'CTX',
      question: 'Q?',
      userPromptPrefix: 'PREFIX',
      questionLabel: 'Question',
    })
    const signal = capturedCalls[0].signal!
    resolveProvider!('done')
    await turn

    // After resolve, controller is cleared; calling abort doesn't re-trigger.
    expect(signal.aborted).toBe(false)
    expect(() => abortChatTurn()).not.toThrow()
    expect(signal.aborted).toBe(false)
  })
})
