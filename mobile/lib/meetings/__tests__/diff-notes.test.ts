import { describe, expect, it } from 'vitest'
import { diffNotes } from '../diff-notes'

describe('diffNotes', () => {
  it('returns empty array when both are null', () => {
    expect(diffNotes(null, null)).toEqual([])
  })

  it('returns empty array when both are empty string', () => {
    expect(diffNotes('', '')).toEqual([])
  })

  it('returns a single unchanged segment for identical inputs', () => {
    const out = diffNotes('hello world', 'hello world')
    expect(out).toEqual([{ kind: 'unchanged', text: 'hello world' }])
  })

  it('marks added words when next adds prose', () => {
    const out = diffNotes('hello', 'hello world')
    const added = out.filter((s) => s.kind === 'added')
    expect(added.length).toBeGreaterThan(0)
    expect(added.map((s) => s.text).join('')).toContain('world')
  })

  it('marks removed words when prev had prose now gone', () => {
    const out = diffNotes('hello world', 'hello')
    const removed = out.filter((s) => s.kind === 'removed')
    expect(removed.map((s) => s.text).join('')).toContain('world')
  })

  it('handles null prev by treating it as empty', () => {
    const out = diffNotes(null, 'hi')
    expect(out.some((s) => s.kind === 'added')).toBe(true)
  })

  it('handles unicode without throwing', () => {
    const out = diffNotes('hello 🚀', 'hello 🌟')
    expect(out.length).toBeGreaterThan(0)
  })

  it('handles multi-line content', () => {
    const out = diffNotes('line one\nline two', 'line one\nline TWO')
    const added = out.filter((s) => s.kind === 'added').map((s) => s.text).join('')
    expect(added).toContain('TWO')
  })
})
