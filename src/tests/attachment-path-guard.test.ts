import { describe, it, expect } from 'vitest'
import { resolveUnder } from '../main/attachments/path-guard'

// The shared traversal guard for the asset:// and cyggie-attachment:// protocol
// handlers. A crafted id must never escape the cache root.

describe('resolveUnder', () => {
  const root = '/var/app/attachment-cache'

  it('resolves a plain id under the root', () => {
    expect(resolveUnder(root, 'abc123')).toBe('/var/app/attachment-cache/abc123')
    expect(resolveUnder(root, 'abc123.json')).toBe('/var/app/attachment-cache/abc123.json')
  })

  it('rejects path traversal escaping the root', () => {
    expect(resolveUnder(root, '../secrets')).toBeNull()
    expect(resolveUnder(root, '../../etc/passwd')).toBeNull()
    expect(resolveUnder(root, 'sub/../../escape')).toBeNull()
  })

  it('contains an absolute-looking path UNDER the root (join strips the leading slash)', () => {
    // Not an escape — `join(root, '/etc/passwd')` → `${root}/etc/passwd`, still
    // inside the root. (And the cuid2 id regex rejects such input upstream.)
    const out = resolveUnder(root, '/etc/passwd')
    expect(out).toBe('/var/app/attachment-cache/etc/passwd')
  })
})
