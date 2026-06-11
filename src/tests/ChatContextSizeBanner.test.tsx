// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import React from 'react'
import type { ChatContextSizeEstimate } from '../shared/types/company'

vi.mock('../renderer/components/chat-panel/ChatContextSizeBanner.module.css', () => ({
  default: { banner: 'banner', summary: 'summary', manageBtn: 'manageBtn' },
}))

// Mock the api shim — control invoke/on directly.
const apiInvoke = vi.fn()
const apiOn = vi.fn()
vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => apiInvoke(...args),
    on: (channel: string, cb: (...a: unknown[]) => void) => apiOn(channel, cb),
  },
}))

const { default: ChatContextSizeBanner } = await import(
  '../renderer/components/chat-panel/ChatContextSizeBanner'
)

const ESTIMATE: ChatContextSizeEstimate = {
  totalChars: 120_000,
  estTokens: 30_000,
  estCostUsd: 0.09,
  willTriggerWarning: false,
  flaggedFileCount: 8,
  breakdown: { meetings: 30_000, notes: 8_000, emails: 0, files: 80_000, externalResearch: 0, contactProfiles: 0, other: 2_000 },
  fileBreakdown: [],
}

beforeEach(() => {
  apiInvoke.mockReset()
  apiOn.mockReset()
  apiOn.mockReturnValue(() => {}) // unsubscribe no-op
})

afterEach(() => cleanup())

describe('ChatContextSizeBanner', () => {
  it('renders nothing when no companies are attached', () => {
    const { container } = render(<ChatContextSizeBanner companyIds={[]} />)
    expect(container.firstChild).toBeNull()
    expect(apiInvoke).not.toHaveBeenCalled()
  })

  it('fetches preflight estimate on mount and renders the banner', async () => {
    apiInvoke.mockResolvedValue(ESTIMATE)
    const { getByRole } = render(<ChatContextSizeBanner companyIds={['co-1']} />)
    await waitFor(() => {
      expect(getByRole('status')).toBeTruthy()
    })
    const banner = getByRole('status')
    expect(banner.textContent).toContain('8 files')
    expect(banner.textContent).toContain('120k chars')
  })

  it('renders nothing when flaggedFileCount === 0 (no banner = no value)', async () => {
    apiInvoke.mockResolvedValue({ ...ESTIMATE, flaggedFileCount: 0 })
    const { container } = render(<ChatContextSizeBanner companyIds={['co-1']} />)
    // Wait for the IPC to resolve
    await waitFor(() => expect(apiInvoke).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('uses singular "file" when flaggedFileCount === 1', async () => {
    apiInvoke.mockResolvedValue({ ...ESTIMATE, flaggedFileCount: 1 })
    const { getByRole } = render(<ChatContextSizeBanner companyIds={['co-1']} />)
    await waitFor(() => {
      expect(getByRole('status').textContent).toContain('1 file ·')
    })
  })

  it('subscribes to COMPANY_FLAGS_CHANGED broadcast', () => {
    apiInvoke.mockResolvedValue(ESTIMATE)
    render(<ChatContextSizeBanner companyIds={['co-1']} />)
    expect(apiOn).toHaveBeenCalledWith(
      'company:flags-changed',
      expect.any(Function),
    )
  })

  it('refetches when COMPANY_FLAGS_CHANGED fires for the matching companyId', async () => {
    apiInvoke.mockResolvedValue(ESTIMATE)
    let broadcastHandler: ((...args: unknown[]) => void) | null = null
    apiOn.mockImplementation((_channel, cb) => {
      broadcastHandler = cb
      return () => {}
    })
    render(<ChatContextSizeBanner companyIds={['co-1']} />)
    await waitFor(() => expect(apiInvoke).toHaveBeenCalledTimes(1))

    // Fire broadcast — should trigger debounced refetch
    expect(broadcastHandler).toBeTruthy()
    broadcastHandler!({ companyId: 'co-1', flagged: true })

    // Wait for debounce (300ms) + IPC settle
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(apiInvoke).toHaveBeenCalledTimes(2)
  })

  it('ignores COMPANY_FLAGS_CHANGED for a different companyId', async () => {
    apiInvoke.mockResolvedValue(ESTIMATE)
    let broadcastHandler: ((...args: unknown[]) => void) | null = null
    apiOn.mockImplementation((_channel, cb) => {
      broadcastHandler = cb
      return () => {}
    })
    render(<ChatContextSizeBanner companyIds={['co-1']} />)
    await waitFor(() => expect(apiInvoke).toHaveBeenCalledTimes(1))

    // Different company's flag changed — banner should NOT refetch
    broadcastHandler!({ companyId: 'co-OTHER', flagged: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(apiInvoke).toHaveBeenCalledTimes(1)
  })

  it('fails open: renders nothing when preflight IPC throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiInvoke.mockRejectedValue(new Error('DB locked'))
    const { container } = render(<ChatContextSizeBanner companyIds={['co-1']} />)
    await waitFor(() => expect(apiInvoke).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
    expect(warn).toHaveBeenCalledWith('[chat-context-banner] preflight failed:', expect.any(Error))
    warn.mockRestore()
  })

  it('Manage files button calls onManageFiles when provided', async () => {
    apiInvoke.mockResolvedValue(ESTIMATE)
    const onManageFiles = vi.fn()
    const { getByRole } = render(
      <ChatContextSizeBanner companyIds={['co-1']} onManageFiles={onManageFiles} />
    )
    await waitFor(() => getByRole('button', { name: /manage files/i }))
    fireEvent.click(getByRole('button', { name: /manage files/i }))
    expect(onManageFiles).toHaveBeenCalledTimes(1)
  })
})
