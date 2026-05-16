/**
 * Tests for frontmatter parsing utilities used by the Apple Notes import path.
 *
 * Both functions fail silently (null on bad input). These tests pin down the
 * happy paths and the silent-failure boundaries so that a regression in either
 * (locale change, format variant, etc.) shows up explicitly.
 */

import { describe, it, expect } from 'vitest'
import { parseFrontmatter, parseAppleNotesDate } from '../main/utils/frontmatter'

describe('parseFrontmatter', () => {
  it('Format A: parses standard YAML with closing ---', () => {
    const content = [
      '---',
      'title: "Jack Whitten"',
      'created: "Friday, October 30, 2020 at 7:25:21 PM"',
      'modified: "Friday, October 30, 2020 at 7:27:31 PM"',
      'folder: "Art"',
      '---',
      '',
      '# Jack Whitten',
      'Body text here',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.frontmatter).toEqual({
      title: 'Jack Whitten',
      created: 'Friday, October 30, 2020 at 7:25:21 PM',
      modified: 'Friday, October 30, 2020 at 7:27:31 PM',
      folder: 'Art',
    })
    expect(result!.body).toBe('# Jack Whitten\nBody text here')
  })

  it('Format B: no closing ---, ## heading prefixes, blank lines between keys', () => {
    const content = [
      '---',
      '',
      '## title: "YOGA"',
      '',
      'created: "Saturday, September 29, 2018 at 10:55:30 AM"',
      'modified: "Saturday, September 29, 2018 at 11:14:42 AM"',
      'folder: "Notes"',
      '',
      'Body text here',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.frontmatter.title).toBe('YOGA')
    expect(result!.frontmatter.created).toBe('Saturday, September 29, 2018 at 10:55:30 AM')
    expect(result!.frontmatter.folder).toBe('Notes')
    expect(result!.body).toBe('Body text here')
  })

  it('returns null when content does not start with ---', () => {
    expect(parseFrontmatter('No frontmatter here\nJust body text')).toBeNull()
  })

  it('returns null when content starts with --- but has no recognizable keys', () => {
    const content = '---\n\nrandom text\nmore text'
    expect(parseFrontmatter(content)).toBeNull()
  })

  it('handles partial frontmatter (only some keys present)', () => {
    const content = [
      '---',
      'title: "Just a title"',
      '---',
      'Body',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.frontmatter).toEqual({ title: 'Just a title' })
    expect(result!.body).toBe('Body')
  })

  it('strips quotes from values (single and double)', () => {
    const content = [
      '---',
      'title: "double-quoted"',
      `folder: 'single-quoted'`,
      '---',
      '',
    ].join('\n')
    const result = parseFrontmatter(content)
    expect(result!.frontmatter.title).toBe('double-quoted')
    expect(result!.frontmatter.folder).toBe('single-quoted')
  })

  it('returns empty string body when no body content present (Format A)', () => {
    const content = ['---', 'title: "x"', '---'].join('\n')
    const result = parseFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.body).toBe('')
  })
})

describe('parseAppleNotesDate', () => {
  it('parses the canonical Apple Notes date format', () => {
    const result = parseAppleNotesDate('Friday, October 30, 2020 at 7:25:21 PM')
    expect(result).not.toBeNull()
    // exact value depends on local timezone, but the date components must be right
    const d = new Date(result!)
    expect(d.getUTCFullYear()).toBe(2020)
    expect(d.getUTCMonth()).toBe(9) // October = 9
    expect(d.getUTCDate()).toBeGreaterThanOrEqual(30) // 30 or 31 depending on TZ
  })

  it('returns null on empty input', () => {
    expect(parseAppleNotesDate('')).toBeNull()
  })

  it('returns null on completely unparseable input', () => {
    expect(parseAppleNotesDate('not a date at all')).toBeNull()
  })

  it('handles AM/PM correctly', () => {
    const morning = parseAppleNotesDate('Friday, October 30, 2020 at 7:25:21 AM')
    const evening = parseAppleNotesDate('Friday, October 30, 2020 at 7:25:21 PM')
    expect(morning).not.toBeNull()
    expect(evening).not.toBeNull()
    expect(new Date(evening!).getTime()).toBeGreaterThan(new Date(morning!).getTime())
  })

  it('returns an ISO 8601 string', () => {
    const result = parseAppleNotesDate('Friday, October 30, 2020 at 7:25:21 PM')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
