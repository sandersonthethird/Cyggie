import { describe, expect, test } from 'vitest'
import { encodeRowId, decodeRowId, encodeRowIdByTable } from '@cyggie/db/sync/encode-row-id'
import { OWNED_TABLES_BY_NAME } from '@cyggie/db/sync/owned-tables'

// Pure-function tests for the outbox row-id encoder. Single-key tables get
// a plain string; composite-key tables get deterministic JSON in canonical
// column order.

describe('encodeRowId / decodeRowId', () => {
  test('single-PK table → plain string', () => {
    const spec = OWNED_TABLES_BY_NAME.get('meetings')!
    expect(encodeRowId(spec, { id: 'meeting-abc', title: 'foo' })).toBe('meeting-abc')
  })

  test('single-PK round-trip', () => {
    const spec = OWNED_TABLES_BY_NAME.get('notes')!
    const encoded = encodeRowId(spec, { id: 'note-1', content: 'hi' })
    const decoded = decodeRowId(spec, encoded)
    expect(decoded).toEqual({ id: 'note-1' })
  })

  test('composite-PK table → JSON in canonical key order', () => {
    const spec = OWNED_TABLES_BY_NAME.get('meeting_company_links')!
    const row = { company_id: 'co-2', meeting_id: 'mtg-1', confidence: 1.0 }
    const encoded = encodeRowId(spec, row)
    // owned-tables.ts declares primaryKey as ['meeting_id', 'company_id'],
    // so JSON keys appear in THAT order regardless of source row order.
    expect(encoded).toBe('{"meeting_id":"mtg-1","company_id":"co-2"}')
  })

  test('composite-PK round-trip preserves both columns', () => {
    const spec = OWNED_TABLES_BY_NAME.get('contact_emails')!
    const encoded = encodeRowId(spec, {
      contact_id: 'ct-9',
      email: 'a@b.com',
      is_primary: 1,
    })
    const decoded = decodeRowId(spec, encoded)
    expect(decoded).toEqual({ contact_id: 'ct-9', email: 'a@b.com' })
  })

  test('throws when a PK column is missing', () => {
    const spec = OWNED_TABLES_BY_NAME.get('meeting_company_links')!
    expect(() => encodeRowId(spec, { meeting_id: 'm1' })).toThrowError(/company_id/)
  })

  test('decodeRowId throws on malformed JSON for composite', () => {
    const spec = OWNED_TABLES_BY_NAME.get('meeting_company_links')!
    expect(() => decodeRowId(spec, 'not-json')).toThrowError(/composite-key JSON/)
  })

  test('encodeRowIdByTable rejects unknown tables', () => {
    expect(() => encodeRowIdByTable('not_a_real_table', { id: 'x' })).toThrowError(
      /not in OWNED_TABLES/,
    )
  })
})
