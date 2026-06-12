import { describe, expect, test } from 'vitest'
import { validateWritePayload } from '@cyggie/db/postgres/write-validators'

// =============================================================================
// Sync-push validator — is_private must ride the outbox like is_pinned.
//
// notes.is_private is a real Postgres boolean (schema/notes.ts). The desktop
// outbox payload carries the mapped JS boolean, so the drizzle-zod validator
// must accept `isPrivate: true/false` WITHOUT an INT_FLAG_KEYS_BY_TABLE coerce
// (same path as is_pinned). If this regressed, a privacy toggle made on
// desktop would be SILENTLY rejected at /sync/push: the desktop would show the
// note private while the gateway kept sharing it. This test is the guard.
// =============================================================================

describe('write-validator accepts notes.is_private', () => {
  test('update payload: isPrivate boolean validates and round-trips', () => {
    const r = validateWritePayload('notes', 'update', { isPrivate: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(true)
  })

  test('update payload: isPrivate false also validates', () => {
    const r = validateWritePayload('notes', 'update', { isPrivate: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(false)
  })

  test('insert payload with is_private (camelCase) validates', () => {
    const r = validateWritePayload('notes', 'insert', {
      id: 'n-test',
      userId: 'u-test',
      content: 'body',
      isPrivate: true,
      isPinned: false,
      lamport: '1',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data['isPrivate']).toBe(true)
  })
})
