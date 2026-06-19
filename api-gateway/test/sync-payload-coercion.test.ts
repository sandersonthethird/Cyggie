import { describe, expect, test } from 'vitest'
import {
  validateWritePayload,
  TABLE_COLUMN_MAPS,
} from '@cyggie/db/postgres/write-validators'

// =============================================================================
// Schema-driven sync-push coercion + name mapping (2026-06-19 hardening).
//
// The desktop emits SQLite-native values that the old hand-maintained coerce
// lists missed, causing the gateway to reject thousands of company/contact
// inserts. These guards lock the schema-driven fixes:
//   • boolean column + number 0/1 → boolean  (contacts.is_private)
//   • timestamp column + ISO string → Date    (contacts.linkedin_enriched_at)
//   • integer column + boolean → 1/0          (regression: include_in_companies_view)
//   • TABLE_COLUMN_MAPS maps digit-suffix columns correctly
//     (followonCheck2 → followon_check_2, which the naive camelToSnake mangled
//      to followon_check2 → "column does not exist").
// =============================================================================

describe('boolean column accepts SQLite integer 0/1', () => {
  test('contacts.isPrivate: 1 → true', () => {
    const r = validateWritePayload('contacts', 'update', { isPrivate: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(true)
  })
  test('contacts.isPrivate: 0 → false', () => {
    const r = validateWritePayload('contacts', 'update', { isPrivate: 0 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(false)
  })
})

describe('timestamp column accepts ISO string', () => {
  test('contacts.linkedinEnrichedAt string → Date', () => {
    const r = validateWritePayload('contacts', 'update', {
      linkedinEnrichedAt: '2026-06-12T00:00:00.000Z',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['linkedinEnrichedAt']).toBeInstanceOf(Date)
  })
})

describe('integer-flag preservation (regression)', () => {
  test('org_companies.includeInCompaniesView: true → 1', () => {
    const r = validateWritePayload('org_companies', 'update', {
      includeInCompaniesView: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['includeInCompaniesView']).toBe(1)
  })
  test('chat_sessions.isActive: true → 1', () => {
    const r = validateWritePayload('chat_sessions', 'update', { isActive: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isActive']).toBe(1)
  })
  test('notes.isPrivate (real boolean) stays boolean', () => {
    const r = validateWritePayload('notes', 'update', { isPrivate: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(true)
  })
})

describe('digit-suffix column name mapping accepts the row', () => {
  test('org_companies.followonCheck2 validates (was rejected by lossy camelToSnake)', () => {
    const r = validateWritePayload('org_companies', 'update', { followonCheck2: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['followonCheck2']).toBe(5)
  })
})

describe('TABLE_COLUMN_MAPS maps digit-suffix columns to real SQL names', () => {
  test('followonCheck2 ↔ followon_check_2 (not followon_check2)', () => {
    const m = TABLE_COLUMN_MAPS['org_companies']
    expect(m).toBeDefined()
    expect(m.camelToSql.get('followonCheck2')).toBe('followon_check_2')
    expect(m.camelToSql.get('followonDate2')).toBe('followon_date_2')
    expect(m.sqlToCamel.get('followon_check_2')).toBe('followonCheck2')
    // canonical columns still map correctly
    expect(m.camelToSql.get('canonicalName')).toBe('canonical_name')
  })
  test('contacts map exists and maps is_private', () => {
    const m = TABLE_COLUMN_MAPS['contacts']
    expect(m.camelToSql.get('isPrivate')).toBe('is_private')
  })
})
