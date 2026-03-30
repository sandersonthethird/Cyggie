// @vitest-environment jsdom
/**
 * Tests for CompanyFiles component — module-level cache behaviour.
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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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

beforeEach(() => {
  filesCache.clear()
  mockInvoke.mockReset()
})

afterEach(() => {
  cleanup()
})

// --- Tests ---

describe('CompanyFiles cache', () => {
  it('MISS — calls IPC and stores result in cache', async () => {
    mockInvoke.mockResolvedValueOnce({ files: MOCK_FILES, companyRoot: '/root' })

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
    mockInvoke.mockResolvedValueOnce({ files: MOCK_FILES, companyRoot: '/root' })

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
