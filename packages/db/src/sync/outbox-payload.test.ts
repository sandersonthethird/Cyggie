import { describe, it, expect } from 'vitest'
import { buildOutboxPayloadJson } from './outbox-payload'
import { OWNED_TABLES_BY_NAME, type OwnedTableSpec } from './owned-tables'

const userScoped: OwnedTableSpec = { table: 'attachments', primaryKey: ['id'], hasUserId: true }
const joinTable: OwnedTableSpec = { table: 'email_contact_links', primaryKey: ['message_id', 'contact_id'], hasUserId: false }

describe('buildOutboxPayloadJson — drop gateway-stamped user_id', () => {
  it('omits camelCase userId (non-field-LWW repo row) but keeps attribution cols', () => {
    // The real shape of the stuck company_flagged_files/attachments rows.
    const row = { id: 'a1', userId: 'local-uuid', flaggedByUserId: 'local-uuid', name: 'file.pdf', lamport: '7' }
    const out = JSON.parse(buildOutboxPayloadJson(userScoped, row))
    expect(out).toEqual({ id: 'a1', flaggedByUserId: 'local-uuid', name: 'file.pdf', lamport: '7' })
    expect('userId' in out).toBe(false)
  })

  it('omits snake_case user_id (field-LWW bare row)', () => {
    const row = { id: 'c1', user_id: 'local-uuid', name: 'Acme', lamport: '7' }
    const out = JSON.parse(buildOutboxPayloadJson(userScoped, row))
    expect(out).toEqual({ id: 'c1', name: 'Acme', lamport: '7' })
    expect('user_id' in out).toBe(false)
  })

  it('does not mutate the input row', () => {
    const row = { id: 'a1', userId: 'local-uuid' }
    buildOutboxPayloadJson(userScoped, row)
    expect(row.userId).toBe('local-uuid')
  })

  it('is a no-op for a hasUserId table whose row has no user_id column', () => {
    // e.g. notes/memos: gateway stamps user_id; payload never had one.
    const row = { id: 'n1', created_by_user_id: 'someone', lamport: '3' }
    const out = JSON.parse(buildOutboxPayloadJson(userScoped, row))
    expect(out).toEqual(row)
  })

  it('keeps user_id for a non-hasUserId join table (scoped via parent)', () => {
    const row = { message_id: 'm1', contact_id: 'c1', user_id: 'x', lamport: '1' }
    const out = JSON.parse(buildOutboxPayloadJson(joinTable, row))
    expect(out).toEqual(row)
  })

  it('strips for the real failing specs (company_flagged_files, attachments)', () => {
    for (const table of ['company_flagged_files', 'attachments']) {
      const spec = OWNED_TABLES_BY_NAME.get(table)!
      expect(spec.hasUserId).toBe(true)
      // Real rows are camelCase (repo return).
      const out = JSON.parse(buildOutboxPayloadJson(spec, { id: 'x', userId: 'local', lamport: '1' }))
      expect('userId' in out).toBe(false)
    }
  })
})
