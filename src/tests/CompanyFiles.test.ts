// @vitest-environment jsdom
/**
 * Tests for CompanyFiles component — module-level cache behaviour
 * + flag-toggle UI (Step 13 of unify-chat-paths refactor).
 *
 * Mock boundaries:
 *   - api.invoke → vi.fn() (controls IPC responses)
 *   - CSS module  → handled transparently by Vite/jsdom
 *
 * Cache state machine under test:
 *
 *   MISS: filesCache empty → IPC called → result stored in cache
 *   HIT:  filesCache populated → IPC NOT called → files shown immediately
 *   PERSIST: unmount → remount same companyId → HIT (IPC called exactly once)
 *
 * Flag-toggle behaviour under test:
 *
 *   - "X of Y included in chat" reflects flagged-id set
 *   - clicking ☆ flips to ★ on success
 *   - rejection (TOO_LARGE/MISSING/UNSUPPORTED_FORMAT) shows the error message
 *     and leaves the icon unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'

// --- Mocks (must be set up before importing the module under test) ---

vi.mock('../renderer/api', () => ({
  api: { invoke: vi.fn() },
}))

// --- Imports after mocks ---

const { CompanyFiles, filesCache } = await import('../renderer/components/company/CompanyFiles')
const { api } = await import('../renderer/api')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

const mockInvoke = api.invoke as ReturnType<typeof vi.fn>

// --- Fixtures ---

const MOCK_FILES = [
  {
    id: '/root/Amma - Term Sheet.pdf',
    name: 'Amma - Term Sheet.pdf',
    mimeType: 'pdf',
    modifiedAt: null,
    webViewLink: null,
    sizeBytes: null,
    parentFolderName: 'root',
  },
]

// --- Setup ---
//
// Channel-aware default: FILE_FLAG_GET resolves to [] unless overridden so
// the cache tests don't have to set it up. Per-test mocks for COMPANY_FILES
// (and FILE_FLAG_TOGGLE in flag tests) override on top of this.

function setupChannelAwareInvoke() {
  mockInvoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
    if (channel === IPC_CHANNELS.COMPANY_FILES) return Promise.resolve({ files: [], companyRoot: null })
    void args
    return Promise.resolve(undefined)
  })
}

beforeEach(() => {
  filesCache.clear()
  mockInvoke.mockReset()
  setupChannelAwareInvoke()
})

afterEach(() => {
  cleanup()
})

// --- Tests ---

describe('CompanyFiles cache', () => {
  it('MISS — calls IPC and stores result in cache', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))

    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(1)
    expect(filesCalls[0]).toEqual([IPC_CHANNELS.COMPANY_FILES, 'company-1'])
    expect(filesCache.get('company-1')).toEqual({ files: MOCK_FILES, companyRoot: '/root' })
  })

  it('HIT — shows files immediately without IPC call', async () => {
    filesCache.set('company-1', { files: MOCK_FILES, companyRoot: '/root' })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))

    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(0)
  })

  it('cross-mount persistence — IPC called exactly once across unmount + remount', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    // First mount — cache miss, IPC fires
    const { unmount } = render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => expect(filesCache.has('company-1')).toBe(true))
    unmount()
    cleanup()

    // Second mount — cache hit, IPC should NOT fire again
    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(1)
  })
})

describe('CompanyFiles flag toggle', () => {
  it('shows "0 of N included in chat" when nothing flagged', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))
    expect(screen.getByText(/0 of 1 included in chat/)).toBeTruthy()
  })

  it('flips icon and counter on successful toggle', async () => {
    let flagged: string[] = []
    mockInvoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve(flagged)
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) {
        flagged = [(payload as { fileId: string }).fileId]
        return Promise.resolve({ ok: true, flagged: true })
      }
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    fireEvent.click(screen.getByTitle('Include in chat context'))

    await waitFor(() => screen.getByTitle('Remove from chat context'))
    expect(screen.getByText(/1 of 1 included in chat/)).toBeTruthy()
  })

  it('shows error message when handler returns ok:false (TOO_LARGE)', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) {
        return Promise.resolve({
          ok: false,
          code: 'TOO_LARGE',
          message: 'File is too large (12.5 MB). Max 10 MB.',
        })
      }
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    fireEvent.click(screen.getByTitle('Include in chat context'))

    await waitFor(() => screen.getByText(/File is too large/))
    // Icon should still be the empty star.
    expect(screen.getByTitle('Include in chat context')).toBeTruthy()
  })
})
