// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readAIChatsExpanded, writeAIChatsExpanded } from '../renderer/utils/sidebar-prefs'

beforeEach(() => {
  localStorage.clear()
})

describe('sidebar-prefs / AI Chats expansion', () => {
  it('returns the default when nothing has been written', () => {
    expect(readAIChatsExpanded(true)).toBe(true)
    expect(readAIChatsExpanded(false)).toBe(false)
  })

  it('round-trips true', () => {
    writeAIChatsExpanded(true)
    expect(readAIChatsExpanded(false)).toBe(true)
  })

  it('round-trips false', () => {
    writeAIChatsExpanded(false)
    expect(readAIChatsExpanded(true)).toBe(false)
  })

  it('returns the default when the value is malformed', () => {
    localStorage.setItem('cyggie:sidebar:aiChatsExpanded', 'maybe')
    expect(readAIChatsExpanded(true)).toBe(true)
    expect(readAIChatsExpanded(false)).toBe(false)
  })

  it('does not throw when localStorage.getItem throws (returns default)', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('blocked')
    })
    expect(() => readAIChatsExpanded(true)).not.toThrow()
    expect(readAIChatsExpanded(true)).toBe(true)
    Storage.prototype.getItem = orig
  })

  it('does not throw when localStorage.setItem throws (silent fallback)', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota')
    })
    expect(() => writeAIChatsExpanded(true)).not.toThrow()
    Storage.prototype.setItem = orig
  })
})
