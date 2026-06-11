/**
 * Guards the surrogate sanitizer applied to every chat prompt before it hits
 * the provider. A lone UTF-16 surrogate (from truncating context mid-emoji, or
 * corrupt source data) makes Anthropic reject the request body with
 * "no low surrogate in string". stripLoneSurrogates replaces unpaired
 * surrogates with U+FFFD while leaving valid pairs intact.
 */
import { describe, it, expect } from 'vitest'
import { stripLoneSurrogates } from '@cyggie/services/llm/chat-runner'

const REPL = '�'

describe('stripLoneSurrogates', () => {
  it('passes through plain ASCII unchanged', () => {
    expect(stripLoneSurrogates('hello world')).toBe('hello world')
  })

  it('preserves a valid surrogate pair (emoji)', () => {
    const emoji = '😀' // U+1F600 = D83D DE00
    expect(stripLoneSurrogates(`a${emoji}b`)).toBe(`a${emoji}b`)
    // The string must still contain the intact pair.
    expect(stripLoneSurrogates(emoji)).toBe(emoji)
  })

  it('replaces a lone HIGH surrogate (emoji cut after the high half)', () => {
    const truncated = 'deal terms ' + '\uD83D' // high surrogate with no low
    expect(stripLoneSurrogates(truncated)).toBe('deal terms ' + REPL)
  })

  it('replaces a lone LOW surrogate at the start of a chunk', () => {
    const tail = '\uDE00' + ' rest of body' // low surrogate, no preceding high
    expect(stripLoneSurrogates(tail)).toBe(REPL + ' rest of body')
  })

  it('replaces a lone LOW surrogate after a normal char without eating it', () => {
    const s = 'x\uDE00y'
    expect(stripLoneSurrogates(s)).toBe('x' + REPL + 'y')
  })

  it('handles two lone high surrogates in a row', () => {
    expect(stripLoneSurrogates('\uD83D\uD83D')).toBe(REPL + REPL)
  })

  it('produces a string that JSON.stringify round-trips cleanly', () => {
    const dirty = 'before ' + '\uD83D' + ' middle ' + '\uDE00' + ' after'
    const clean = stripLoneSurrogates(dirty)
    // No lone surrogates remain → encodeURIComponent (which throws on lone
    // surrogates) succeeds.
    expect(() => encodeURIComponent(clean)).not.toThrow()
    expect(JSON.parse(JSON.stringify(clean))).toBe(clean)
  })
})
