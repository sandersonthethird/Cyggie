import { describe, it, expect } from 'vitest'
import { stripMarkdownPreview } from '../renderer/utils/format'

const strip = stripMarkdownPreview

describe('stripMarkdownPreview', () => {
  it('strips heading markers', () => expect(strip('# Hello')).toBe('Hello'))
  it('strips h2/h3', () => expect(strip('## Sub\n### Deep')).toBe('Sub Deep'))
  it('strips **bold**', () => expect(strip('**bold** text')).toBe('bold text'))
  it('strips __bold__', () => expect(strip('__bold__ text')).toBe('bold text'))
  it('strips *italic*', () => expect(strip('*italic*')).toBe('italic'))
  it('strips _italic_', () => expect(strip('_italic_')).toBe('italic'))
  it('strips `code`', () => expect(strip('use `foo()`')).toBe('use foo()'))
  it('strips [text](url) leaving text', () => expect(strip('[click](https://x.com)')).toBe('click'))
  it('strips > blockquote', () => expect(strip('> quoted')).toBe('quoted'))
  it('collapses newlines to single space', () => expect(strip('a\n\nb')).toBe('a b'))
  it('returns empty string for empty input', () => expect(strip('')).toBe(''))
  it('handles content with only heading lines', () => expect(strip('# Title\n## Sub')).toBe('Title Sub'))
})
