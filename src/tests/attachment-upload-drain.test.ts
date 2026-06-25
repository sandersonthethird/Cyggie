import { describe, it, expect, vi } from 'vitest'
import {
  drainPendingUploads,
  decideUploadStatus,
  type DrainDeps,
} from '../main/services/attachment-upload-drain'
import type { AttachmentUpload } from '@cyggie/db/sqlite/repositories'

// Pure drain core for the attachment "byte outbox". Verified with fakes — no
// Electron / DB / network. This is the logic that must never get wrong:
// upload-or-skip-or-pause, and retry→dead.

function upload(over: Partial<AttachmentUpload> = {}): AttachmentUpload {
  return {
    id: 1,
    attachmentId: 'abc123',
    userId: 'u1',
    ownerType: 'note',
    ownerId: 'note1',
    filename: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    checksum: 'sum',
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: '2026-06-25 00:00:00',
    ...over,
  }
}

function baseDeps(over: Partial<DrainDeps> = {}): DrainDeps {
  return {
    getToken: async () => 'tok',
    collectReferenced: () => new Set(['abc123']),
    listPending: () => [upload()],
    readBytes: () => Buffer.from('bytes'),
    dropOrphan: vi.fn(),
    upload: vi.fn(async () => {}),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
    isAuthError: (e) => e instanceof Error && e.message === 'AUTH',
    maxAttempts: 5,
    ...over,
  }
}

describe('decideUploadStatus', () => {
  it('is failed before MAX, dead at/after MAX', () => {
    expect(decideUploadStatus(1, 5)).toBe('failed')
    expect(decideUploadStatus(4, 5)).toBe('failed')
    expect(decideUploadStatus(5, 5)).toBe('dead')
    expect(decideUploadStatus(6, 5)).toBe('dead')
  })
})

describe('drainPendingUploads', () => {
  it('uploads a referenced pending item and marks it done', async () => {
    const deps = baseDeps()
    const r = await drainPendingUploads(deps)
    expect(deps.upload).toHaveBeenCalledTimes(1)
    expect(deps.onSuccess).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ uploaded: 1, dropped: 0, failed: 0, pausedNoAuth: false })
  })

  it('pauses (uploads nothing) when not signed in', async () => {
    const deps = baseDeps({ getToken: async () => null })
    const r = await drainPendingUploads(deps)
    expect(deps.upload).not.toHaveBeenCalled()
    expect(r.pausedNoAuth).toBe(true)
  })

  it('DROPS an orphan (deleted before upload) instead of uploading it', async () => {
    const deps = baseDeps({ collectReferenced: () => new Set() }) // id no longer referenced
    const r = await drainPendingUploads(deps)
    expect(deps.dropOrphan).toHaveBeenCalledTimes(1)
    expect(deps.upload).not.toHaveBeenCalled()
    expect(r.dropped).toBe(1)
  })

  it('marks dead when the cache bytes are missing', async () => {
    const deps = baseDeps({ readBytes: () => null })
    await drainPendingUploads(deps)
    expect(deps.onFailure).toHaveBeenCalledWith(expect.anything(), 'dead', expect.any(String))
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('on a transient upload failure marks failed (attempts<MAX) and stops the batch', async () => {
    const deps = baseDeps({
      listPending: () => [upload({ id: 1, attempts: 0 }), upload({ id: 2, attachmentId: 'def456', attempts: 0 })],
      collectReferenced: () => new Set(['abc123', 'def456']),
      upload: vi.fn(async () => {
        throw new Error('network')
      }),
    })
    const r = await drainPendingUploads(deps)
    expect(deps.onFailure).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'failed', 'network')
    // stops the batch on first failure — second item not attempted this tick
    expect(deps.upload).toHaveBeenCalledTimes(1)
    expect(r.failed).toBe(1)
  })

  it('marks dead at MAX attempts', async () => {
    const deps = baseDeps({
      listPending: () => [upload({ attempts: 4 })], // +1 → 5 == MAX
      upload: vi.fn(async () => {
        throw new Error('network')
      }),
    })
    await drainPendingUploads(deps)
    expect(deps.onFailure).toHaveBeenCalledWith(expect.anything(), 'dead', 'network')
  })

  it('an auth error mid-drain pauses without penalizing the row', async () => {
    const deps = baseDeps({
      upload: vi.fn(async () => {
        throw new Error('AUTH')
      }),
    })
    const r = await drainPendingUploads(deps)
    expect(r.pausedNoAuth).toBe(true)
    expect(deps.onFailure).not.toHaveBeenCalled()
  })
})
