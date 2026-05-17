/**
 * Tests for parseInvestorsJson — parses SQLite json_group_array output.
 * Tolerates: null, '[]', valid JSON, malformed JSON.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The repo file imports better-sqlite3 etc., but parseInvestorsJson is
// pure and exported. Direct import works without DB initialization.
import { parseInvestorsJson } from '@cyggie/db/sqlite/repositories/org-company.repo'

describe('parseInvestorsJson', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('returns empty array for null', () => {
    expect(parseInvestorsJson(null)).toEqual([])
  })

  it('returns empty array for undefined', () => {
    expect(parseInvestorsJson(undefined)).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(parseInvestorsJson('')).toEqual([])
  })

  it('returns empty array for empty JSON array', () => {
    expect(parseInvestorsJson('[]')).toEqual([])
  })

  it('parses a single entry with domain', () => {
    expect(parseInvestorsJson('[{"id":"abc","name":"Sequoia","domain":"sequoia.com"}]')).toEqual([
      { id: 'abc', name: 'Sequoia', domain: 'sequoia.com' },
    ])
  })

  it('parses multiple entries', () => {
    const raw = '[{"id":"a","name":"A","domain":"a.com"},{"id":"b","name":"B","domain":null}]'
    expect(parseInvestorsJson(raw)).toEqual([
      { id: 'a', name: 'A', domain: 'a.com' },
      { id: 'b', name: 'B', domain: null },
    ])
  })

  it('coerces missing domain to null', () => {
    expect(parseInvestorsJson('[{"id":"x","name":"X"}]')).toEqual([
      { id: 'x', name: 'X', domain: null },
    ])
  })

  it('skips entries missing id or name', () => {
    const raw = '[{"id":"a","name":"A"},{"name":"orphan"},{"id":"c"}]'
    expect(parseInvestorsJson(raw)).toEqual([
      { id: 'a', name: 'A', domain: null },
    ])
  })

  it('returns empty array on malformed JSON and logs', () => {
    expect(parseInvestorsJson('not-json')).toEqual([])
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('returns empty array when JSON is not an array', () => {
    expect(parseInvestorsJson('{"id":"a","name":"A"}')).toEqual([])
  })

  it('rejects non-string id/name fields', () => {
    expect(parseInvestorsJson('[{"id":123,"name":"A"},{"id":"b","name":456}]')).toEqual([])
  })
})
