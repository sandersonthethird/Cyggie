// Unit tests for slice 5 — markdown → Slack mrkdwn converter.

import { describe, expect, test } from 'vitest'
import { markdownToMrkdwn } from '../src/slack/markdown-to-mrkdwn'

describe('markdownToMrkdwn: bold', () => {
  test('converts **bold** to single-asterisk *bold*', () => {
    expect(markdownToMrkdwn('Hello **world**, **how** are you?')).toBe(
      'Hello *world*, *how* are you?',
    )
  })

  test('leaves single-asterisk *italic* as Slack italic _italic_', () => {
    expect(markdownToMrkdwn('Hello *world*')).toBe('Hello _world_')
  })

  test('handles bold-then-italic in same line', () => {
    expect(markdownToMrkdwn('**bold** and *italic*')).toBe('*bold* and _italic_')
  })

  test('does not eat italic inside already-converted bold', () => {
    // *bold* (Slack) should NOT become _bold_ when it was originally **bold**
    expect(markdownToMrkdwn('**foo**')).toBe('*foo*')
  })
})

describe('markdownToMrkdwn: links', () => {
  test('converts [text](url) to <url|text>', () => {
    expect(markdownToMrkdwn('See [Acme](cyggie://company/abc) for details.')).toBe(
      'See <cyggie://company/abc|Acme> for details.',
    )
  })

  test('preserves https links via the same conversion', () => {
    expect(markdownToMrkdwn('[Docs](https://example.com/x)')).toBe(
      '<https://example.com/x|Docs>',
    )
  })

  test('escapes pipe in display text (Slack uses | as separator)', () => {
    const out = markdownToMrkdwn('[Acme | Holdings](cyggie://company/abc)')
    expect(out).toBe('<cyggie://company/abc|Acme ∣ Holdings>')
  })

  test('link with **bold** inside display text gets bold converted', () => {
    // [bold company](url) — link's display text passes through the
    // bold pass too, so `**Acme**` becomes Slack `*Acme*` inside the
    // <url|display> wrapper. Reasonable behavior — users see bold
    // text in the link label, just like they would in plain prose.
    expect(markdownToMrkdwn('[**Acme**](cyggie://company/abc)')).toBe(
      '<cyggie://company/abc|*Acme*>',
    )
  })
})

describe('markdownToMrkdwn: headers', () => {
  test('# H1 becomes bold', () => {
    expect(markdownToMrkdwn('# Hello')).toBe('*Hello*')
  })

  test('## H2 becomes bold', () => {
    expect(markdownToMrkdwn('## Section')).toBe('*Section*')
  })

  test('### H3 becomes bold', () => {
    expect(markdownToMrkdwn('### Subsection')).toBe('*Subsection*')
  })

  test('header in middle of doc works (multi-line)', () => {
    const out = markdownToMrkdwn('para\n\n## Section\n\nmore para')
    expect(out).toContain('*Section*')
    expect(out).not.toContain('## ')
  })

  test('hash-symbol not at line start is left alone', () => {
    expect(markdownToMrkdwn('This is #cool not a header')).toBe(
      'This is #cool not a header',
    )
  })
})

describe('markdownToMrkdwn: lists', () => {
  test('converts dash bullets to • bullets', () => {
    const out = markdownToMrkdwn('- one\n- two\n- three')
    expect(out).toBe('•  one\n•  two\n•  three')
  })

  test('converts asterisk bullets to • bullets', () => {
    const out = markdownToMrkdwn('* one\n* two')
    expect(out).toBe('•  one\n•  two')
  })

  test('preserves leading whitespace (indented list)', () => {
    const out = markdownToMrkdwn('  - nested')
    expect(out).toBe('  •  nested')
  })

  test('leaves numbered lists alone', () => {
    const out = markdownToMrkdwn('1. first\n2. second')
    expect(out).toBe('1. first\n2. second')
  })
})

describe('markdownToMrkdwn: strikethrough + underline', () => {
  test('converts ~~strike~~ to ~strike~', () => {
    expect(markdownToMrkdwn('That is ~~wrong~~')).toBe('That is ~wrong~')
  })

  test('converts __underline__ to _underline_', () => {
    expect(markdownToMrkdwn('__important__')).toBe('_important_')
  })
})

describe('markdownToMrkdwn: code preservation', () => {
  test('inline `code` is preserved (not converted)', () => {
    expect(markdownToMrkdwn('Use `foo()` not `bar()`')).toBe(
      'Use `foo()` not `bar()`',
    )
  })

  test('code block preserved verbatim including its contents', () => {
    const md = 'Here:\n```\n**not bold inside**\n[not a link](url)\n```\nafter'
    const out = markdownToMrkdwn(md)
    expect(out).toContain('**not bold inside**')
    expect(out).toContain('[not a link](url)')
  })

  test('inline code with markdown syntax inside is preserved', () => {
    expect(markdownToMrkdwn('Try `**bold**`')).toBe('Try `**bold**`')
  })

  test('multiple code blocks each preserved separately', () => {
    const md = '```\nfirst\n```\nmid\n```\nsecond\n```'
    const out = markdownToMrkdwn(md)
    expect(out).toContain('```\nfirst\n```')
    expect(out).toContain('```\nsecond\n```')
    expect(out).toContain('mid')
  })
})

describe('markdownToMrkdwn: combined real-world LLM output', () => {
  test('typical Cyggie answer with bold + link + bullets', () => {
    const md = `**Acme Corp** raised **$12.5M Series A** on 2024-03-15, led by **Sequoia**.

Key facts:
- Industry: AI infrastructure
- Stage: Series A
- Last meeting: 2 weeks ago

[View in Cyggie](cyggie://company/co_abc123)`
    const out = markdownToMrkdwn(md)
    expect(out).toContain('*Acme Corp*')
    expect(out).toContain('*$12.5M Series A*')
    expect(out).toContain('•  Industry: AI infrastructure')
    expect(out).toContain('<cyggie://company/co_abc123|View in Cyggie>')
    expect(out).not.toContain('**')
    expect(out).not.toContain('[View')
  })

  test('empty input returns empty string', () => {
    expect(markdownToMrkdwn('')).toBe('')
  })
})
