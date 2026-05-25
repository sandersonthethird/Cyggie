import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock RN's Linking + minimal StyleSheet surface. The vitest.config alias
// already points 'react-native' at _stubs/react-native.ts, but that stub
// doesn't export Linking — we mock the specific surfaces this module
// touches per the stub's documented pattern. vi.hoisted is required
// because vi.mock factories are hoisted above local consts.
const { openURLMock } = vi.hoisted(() => ({
  openURLMock: vi.fn<(url: string) => Promise<boolean>>(),
}))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  return {
    ...actual,
    Linking: { openURL: openURLMock },
  }
})

// react-native-markdown-display would otherwise pull in real RN native
// surfaces at import time. We don't render <RichMarkdown> in this runner
// (UI tests belong in a separate mobile-side runner per the repo's vitest
// comments), so a stub default + MarkdownIt identity is enough.
vi.mock('react-native-markdown-display', () => ({
  default: () => null,
  MarkdownIt: () => ({}),
}))

import { handleLinkPress, stripMarkdown } from '../markdown'

describe('stripMarkdown', () => {
  it('returns empty string for null/undefined/non-string', () => {
    expect(stripMarkdown(null)).toBe('')
    expect(stripMarkdown(undefined)).toBe('')
    // @ts-expect-error — exercise runtime guard
    expect(stripMarkdown(42)).toBe('')
    expect(stripMarkdown('')).toBe('')
  })

  it('strips ATX headings', () => {
    expect(stripMarkdown('# Heading')).toBe('Heading')
    expect(stripMarkdown('## Sub')).toBe('Sub')
    expect(stripMarkdown('###### Six')).toBe('Six')
  })

  it('strips bold (** and __) keeping inner text', () => {
    expect(stripMarkdown('hello **world**')).toBe('hello world')
    expect(stripMarkdown('__bold__ word')).toBe('bold word')
  })

  it('strips italic (* and _) keeping inner text', () => {
    expect(stripMarkdown('an *italic* phrase')).toBe('an italic phrase')
    expect(stripMarkdown('an _italic_ phrase')).toBe('an italic phrase')
  })

  it('strips inline code', () => {
    expect(stripMarkdown('use `npm install`')).toBe('use npm install')
  })

  it('strips link syntax to label only', () => {
    expect(stripMarkdown('see [Anthropic](https://anthropic.com)')).toBe(
      'see Anthropic',
    )
  })

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> quoted')).toBe('quoted')
  })

  it('strips bullet markers', () => {
    expect(stripMarkdown('- item one\n- item two')).toBe('item one item two')
    expect(stripMarkdown('* item one\n+ item two')).toBe('item one item two')
  })

  it('collapses whitespace + newlines', () => {
    expect(stripMarkdown('a\n\nb   c')).toBe('a b c')
  })

  it('combines all markdown features cleanly', () => {
    const input = '# Title\n\nSome **bold** with [link](https://x.co) and `code`.\n- one\n- two'
    expect(stripMarkdown(input)).toBe('Title Some bold with link and code. one two')
  })

  it('preserves lonely asterisks (italic regex requires a closing *)', () => {
    expect(stripMarkdown('5 * 3 = 15')).toBe('5 * 3 = 15')
  })

  it('known limitation: matched pair around arithmetic still collapses', () => {
    // If a user writes `2 *3 = 6*` (two asterisks bracketing a phrase),
    // the italic regex matches and strips. Preview-only context, OK.
    expect(stripMarkdown('value 2 *3 = 6*')).toBe('value 2 3 = 6')
  })
})

describe('handleLinkPress', () => {
  beforeEach(() => {
    openURLMock.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false (prevents default lib behavior)', () => {
    openURLMock.mockResolvedValue(true)
    expect(handleLinkPress('https://example.com')).toBe(false)
  })

  it('calls Linking.openURL with the supplied URL', () => {
    openURLMock.mockResolvedValue(true)
    handleLinkPress('https://anthropic.com')
    expect(openURLMock).toHaveBeenCalledWith('https://anthropic.com')
  })

  it('logs a warning on Linking.openURL rejection without throwing', async () => {
    openURLMock.mockRejectedValue(new Error('no handler'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => handleLinkPress('xyz://nope')).not.toThrow()
    // wait a microtask for the .catch to fire
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledOnce()
    const [msg, ctx] = warn.mock.calls[0]!
    expect(msg).toContain('failed to open link')
    expect((ctx as { url: string }).url).toBe('xyz://nope')
  })
})
