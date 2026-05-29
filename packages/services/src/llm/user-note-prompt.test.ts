import { describe, expect, it } from 'vitest'
import { USER_NOTE_SYSTEM_RULE, userNoteContextBlock } from './user-note-prompt'

describe('userNoteContextBlock', () => {
  it('returns empty string for null', () => {
    expect(userNoteContextBlock(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(userNoteContextBlock(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(userNoteContextBlock('')).toBe('')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(userNoteContextBlock('   \n\t  ')).toBe('')
  })

  it('embeds a single-line note inside the labelled block', () => {
    const out = userNoteContextBlock('Lead investor on seed.')
    expect(out).toContain("USER'S OWN NOTES")
    expect(out).toContain('Lead investor on seed.')
  })

  it('trims surrounding whitespace from the note', () => {
    const out = userNoteContextBlock('   hello   ')
    // No leading/trailing spaces around the actual note content.
    expect(out.endsWith('hello')).toBe(true)
    expect(out).not.toContain('   hello')
  })

  it('preserves embedded newlines (multi-line notes become multi-line bullets)', () => {
    const out = userNoteContextBlock('line one\nline two\nline three')
    expect(out).toContain('line one\nline two\nline three')
  })

  it('leads with two newlines so it appends cleanly to existing prompt text', () => {
    const out = userNoteContextBlock('x')
    expect(out.startsWith('\n\n')).toBe(true)
  })
})

describe('USER_NOTE_SYSTEM_RULE', () => {
  it('is a non-empty instruction string', () => {
    expect(USER_NOTE_SYSTEM_RULE.length).toBeGreaterThan(20)
  })

  it("references the USER'S OWN NOTES label so the model can correlate it with the user prompt", () => {
    expect(USER_NOTE_SYSTEM_RULE).toContain("USER'S OWN NOTES")
  })

  it("instructs the model not to restate the user's points", () => {
    expect(USER_NOTE_SYSTEM_RULE.toLowerCase()).toContain('not restate')
  })
})
