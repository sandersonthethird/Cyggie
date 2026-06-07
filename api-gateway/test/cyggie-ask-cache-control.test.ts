import { describe, expect, test } from 'vitest'
import { buildCyggieAskSystem, CYGGIE_ASK_SYSTEM_PROMPT } from '../src/services/chat-agent/cyggie-ask'

// Part 2 — guards the exact `system` shape sent to Anthropic when a focus
// block is injected. A malformed cache_control block is a non-retried
// BadRequestError that fails the WHOLE answer (classifyAnthropicError doesn't
// retry 4xx), so this shape is load-bearing and must not drift.

describe('buildCyggieAskSystem — cache_control shape', () => {
  test('no focus block → plain string prompt (no write premium, today\'s behavior)', () => {
    const system = buildCyggieAskSystem(undefined)
    expect(system).toBe(CYGGIE_ASK_SYSTEM_PROMPT)
    expect(typeof system).toBe('string')
  })

  test('with focus block → [base, focus] with ephemeral cache_control only on focus', () => {
    const block = 'COMPANY: Acme\nIndustry: AI\n\nMeeting: sync — 5/22\nNotes:\nx'
    const system = buildCyggieAskSystem(block)

    expect(Array.isArray(system)).toBe(true)
    const segs = system as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(segs).toHaveLength(2)

    // Base segment: the verbatim prompt, NO cache_control (the breakpoint on
    // the trailing segment already caches everything before it).
    expect(segs[0]?.type).toBe('text')
    expect(segs[0]?.text).toBe(CYGGIE_ASK_SYSTEM_PROMPT)
    expect(segs[0]?.cache_control).toBeUndefined()

    // Focus segment: the block + a "don't re-fetch" instruction + the
    // breakpoint. Exactly { type: 'ephemeral' } — the only shape the API accepts.
    expect(segs[1]?.type).toBe('text')
    expect(segs[1]?.text).toContain(block)
    expect(segs[1]?.text.toLowerCase()).toContain('already been loaded')
    expect(segs[1]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('empty-string focus block is treated as absent (no segment)', () => {
    // '' is falsy → plain string, so we never emit an empty cached segment.
    expect(buildCyggieAskSystem('')).toBe(CYGGIE_ASK_SYSTEM_PROMPT)
  })
})
