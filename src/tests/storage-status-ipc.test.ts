/**
 * computeSharedStorageStatus — the paused/message logic behind the renderer's
 * "shared files paused" banner. Deps (flag, shared-root state, queue depth) are
 * mocked so we can drive every combination directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SharedRootState } from '../main/storage/shared-root'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

const flag = { on: true }
const state = { value: { status: 'unset' } as SharedRootState }
const depth = { value: 0 }

vi.mock('../main/storage/routing', () => ({
  isTwoTierStorageEnabled: () => flag.on,
}))
vi.mock('../main/storage/shared-root', () => ({
  getSharedRootState: () => state.value,
}))
vi.mock('../main/storage/hold-queue', () => ({
  getHoldQueueDepth: () => depth.value,
  setHoldQueueChangeListener: vi.fn(),
}))

const { computeSharedStorageStatus } = await import('../main/ipc/storage.ipc')

beforeEach(() => {
  flag.on = true
  state.value = { status: 'unset' }
  depth.value = 0
})

describe('computeSharedStorageStatus', () => {
  it('flag OFF → always idle, even with a non-empty queue', () => {
    flag.on = false
    state.value = { status: 'unresolved', reason: 'no-drive-mount' }
    depth.value = 3
    expect(computeSharedStorageStatus()).toEqual({ paused: false, queueDepth: 0, message: null })
  })

  it('paused only when the shared root is unresolved AND files are held', () => {
    state.value = { status: 'unresolved', reason: 'folder-not-found' }
    depth.value = 2
    const status = computeSharedStorageStatus()
    expect(status.paused).toBe(true)
    expect(status.queueDepth).toBe(2)
    expect(status.message).toMatch(/shared files.*paused/i)
  })

  it('unresolved but empty queue → not paused (nothing is actually blocked)', () => {
    state.value = { status: 'unresolved', reason: 'fetch-failed' }
    depth.value = 0
    expect(computeSharedStorageStatus()).toEqual({ paused: false, queueDepth: 0, message: null })
  })

  it('resolved with a draining queue → not paused', () => {
    state.value = { status: 'resolved', path: '/x' }
    depth.value = 1
    expect(computeSharedStorageStatus()).toEqual({ paused: false, queueDepth: 1, message: null })
  })
})
