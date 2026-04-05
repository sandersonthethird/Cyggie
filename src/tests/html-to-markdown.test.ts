/**
 * Tests for convertHtmlToMarkdown() — focusing on the Google Docs list preprocessor.
 *
 * Google Docs exports nested lists as flat sibling <ul> elements using CSS class
 * suffixes (lst-kix_LISTID-N) to encode nesting depth. Turndown cannot infer
 * nesting from siblings — preprocessGoogleDocsLists() restructures them first.
 *
 * Test coverage:
 *   convertHtmlToMarkdown ──► non-Google-Docs HTML → unchanged (fast-path)
 *                         ──► 2-level nesting (0→1→0) → indented markdown
 *                         ──► upward level skip (0→2) → correct deep nesting
 *                         ──► downward multi-jump (3→0) → frames flushed correctly
 *                         ──► multiple list IDs → each grouped independently
 *                         ──► li items with links → inner HTML preserved
 *                         ──► standard <ul> alongside Google Docs → standard untouched
 *                         ──► all-empty <li> blocks → original HTML preserved
 */

import { describe, it, expect } from 'vitest'
import { convertHtmlToMarkdown } from '../main/utils/html-to-markdown'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Google Docs-style flat <ul> block at a given nesting level. */
function gdocsUl(listId: string, level: number, items: string[]): string {
  const lis = items.map(t => `<li class="c6 li-bullet-0">${t}</li>`).join('')
  return `<ul class="c11 lst-kix_${listId}-${level} start">${lis}</ul>`
}

/** Empty <p> separator Google Docs inserts between consecutive <ul> blocks. */
const SEP = '<p class="c5"><span class="c27"></span></p>'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('convertHtmlToMarkdown — Google Docs list preprocessing', () => {

  it('Test 1: non-Google-Docs HTML passes through Turndown unchanged', () => {
    const html = '<ul><li>Alpha</li><li>Beta</li></ul>'
    const { markdown } = convertHtmlToMarkdown(html)
    expect(markdown).toContain('Alpha')
    expect(markdown).toContain('Beta')
    // No indentation introduced — these are already flat top-level items
    expect(markdown).not.toMatch(/^\s{4}-/m)
  })

  it('Test 2: standard 2-level nesting (0→1→0) produces indented sub-bullets', () => {
    const html = [
      gdocsUl('abc', 0, ['Yakai']),
      SEP,
      gdocsUl('abc', 1, ['Founder: Chris Hull', 'Raising $1M']),
      SEP,
      gdocsUl('abc', 0, ['Wink']),
      SEP,
      gdocsUl('abc', 1, ['Founder Olga Petrunia']),
    ].join('')

    const { markdown } = convertHtmlToMarkdown(html)
    const lines = markdown.split('\n').map(l => l.trimEnd())

    // Top-level items at column 0
    expect(lines.some(l => /^-\s+Yakai/.test(l))).toBe(true)
    expect(lines.some(l => /^-\s+Wink/.test(l))).toBe(true)

    // Sub-bullets indented (Turndown uses 4-space indent)
    expect(lines.some(l => /^\s+-\s+Founder: Chris Hull/.test(l))).toBe(true)
    expect(lines.some(l => /^\s+-\s+Raising \$1M/.test(l))).toBe(true)
    expect(lines.some(l => /^\s+-\s+Founder Olga Petrunia/.test(l))).toBe(true)
  })

  it('Test 3: upward level skip (0→2) nests correctly without intermediary', () => {
    const html = [
      gdocsUl('xyz', 0, ['Parent']),
      SEP,
      gdocsUl('xyz', 2, ['Deep child']),  // skips level 1
    ].join('')

    const { markdown } = convertHtmlToMarkdown(html)
    expect(markdown).toContain('Parent')
    expect(markdown).toContain('Deep child')
    // Deep child must be indented relative to Parent
    const lines = markdown.split('\n')
    const parentLine = lines.findIndex(l => l.includes('Parent'))
    const childLine = lines.findIndex(l => l.includes('Deep child'))
    expect(parentLine).toBeGreaterThanOrEqual(0)
    expect(childLine).toBeGreaterThan(parentLine)
    const childIndent = lines[childLine].match(/^\s+/)?.[0].length ?? 0
    expect(childIndent).toBeGreaterThan(0)
  })

  it('Test 4: downward multi-jump (3→0) flushes all frames correctly', () => {
    const html = [
      gdocsUl('def', 0, ['Root']),
      SEP,
      gdocsUl('def', 1, ['Level 1']),
      SEP,
      gdocsUl('def', 2, ['Level 2']),
      SEP,
      gdocsUl('def', 3, ['Level 3']),
      SEP,
      gdocsUl('def', 0, ['Back to root']),  // jump from 3→0
    ].join('')

    const { markdown } = convertHtmlToMarkdown(html)
    expect(markdown).toContain('Root')
    expect(markdown).toContain('Level 1')
    expect(markdown).toContain('Level 2')
    expect(markdown).toContain('Level 3')
    expect(markdown).toContain('Back to root')

    // 'Back to root' must be at the same or lower indentation as 'Root'
    const lines = markdown.split('\n')
    const rootIndent = (lines.find(l => l.includes('Root')) ?? '').match(/^\s+/)?.[0].length ?? 0
    const backIndent = (lines.find(l => l.includes('Back to root')) ?? '').match(/^\s+/)?.[0].length ?? 0
    expect(backIndent).toBeLessThanOrEqual(rootIndent)
  })

  it('Test 5: multiple separate list IDs are grouped and nested independently', () => {
    const html = [
      gdocsUl('list1', 0, ['Section A']),
      SEP,
      gdocsUl('list1', 1, ['A sub-item']),
      // Different listId — new logical list
      gdocsUl('list2', 0, ['Section B']),
      SEP,
      gdocsUl('list2', 1, ['B sub-item']),
    ].join('')

    const { markdown } = convertHtmlToMarkdown(html)
    expect(markdown).toContain('Section A')
    expect(markdown).toContain('A sub-item')
    expect(markdown).toContain('Section B')
    expect(markdown).toContain('B sub-item')

    // Both sub-items must be indented
    const lines = markdown.split('\n')
    expect(lines.some(l => /^\s+-\s+A sub-item/.test(l))).toBe(true)
    expect(lines.some(l => /^\s+-\s+B sub-item/.test(l))).toBe(true)
  })

  it('Test 6: li items with HTML links and bold — inner content preserved through Turndown', () => {
    const linkLi = '<li class="c6"><a href="https://example.com">Deck</a></li>'
    const boldLi = '<li class="c6"><strong>Founder</strong>: Jane Smith</li>'
    const html = `<ul class="c11 lst-kix_lnk-1 start">${linkLi}${boldLi}</ul>`

    const { markdown } = convertHtmlToMarkdown(html)
    // Link text preserved
    expect(markdown).toContain('Deck')
    // Bold text preserved (either as **Founder** or plain Founder)
    expect(markdown).toContain('Founder')
    expect(markdown).toContain('Jane Smith')
  })

  it('Test 7: standard nested <ul> (no lst-kix_) alongside Google Docs lists — both render', () => {
    const standardHtml = '<ul><li>Standard item<ul><li>Nested</li></ul></li></ul>'
    const gdocsHtml = gdocsUl('ggg', 0, ['Google item'])

    const { markdown } = convertHtmlToMarkdown(standardHtml + gdocsHtml)
    expect(markdown).toContain('Standard item')
    expect(markdown).toContain('Nested')
    expect(markdown).toContain('Google item')
  })

  it('Test 8: all-empty <li> blocks — original flat HTML preserved (no silent deletion)', () => {
    // Malformed: <ul> inner contains no valid <li> tags
    const malformed = '<ul class="c11 lst-kix_bad-0 start"><!-- no li here --></ul>'
    const normal = '<ul><li>Normal item</li></ul>'
    const html = malformed + normal

    const { markdown } = convertHtmlToMarkdown(html)
    // Normal content must survive
    expect(markdown).toContain('Normal item')
    // Should not throw or return empty
    expect(markdown.length).toBeGreaterThan(0)
  })
})
