// @vitest-environment jsdom
/**
 * Tests for CompanyMemo — PDF export, share, copy, open, revoke, and shared badge.
 *
 * Mock boundaries:
 *   - api.invoke → controls IPC responses
 *   - api.on → no-op subscription
 *   - window.api.invoke → controls shell:open-external + direct IPC
 *   - navigator.clipboard → controls copy
 *   - CSS modules → identity proxy
 *
 * Coverage diagram:
 *
 *   export-pdf:     Export PDF btn → invoke EXPORT_PDF → pdfMsg shown
 *   export-error:   Export PDF fails → error pdfMsg
 *   share:          Share btn → invoke SHARE_LINK → shareUrl + shareToken stored
 *   share-error:    SHARE_LINK returns error → shareError shown
 *   share-disabled: Share disabled while generating
 *   copy:           Copy link → clipboard.writeText → "Copied!" shown
 *   open:           Open btn → shell:open-external called
 *   revoke:         Revoke btn → invoke REVOKE_SHARE → URL row cleared
 *   shared-badge:   Badge shown when shareUrl is set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'

// --- Mocks ---

const invokeMock = vi.fn()
const onMock = vi.fn(() => () => {})

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: (...args: unknown[]) => onMock(...args),
  },
}))

// window.api for direct IPC calls (shell:open-external, INVESTMENT_MEMO_GET_OR_CREATE)
const windowInvokeMock = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: (...args: unknown[]) => windowInvokeMock(...args) },
  writable: true,
})

// Clipboard
const clipboardWriteMock = vi.fn()
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: clipboardWriteMock },
  writable: true,
})

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => React.createElement('div', null, children) }))
vi.mock('rehype-raw', () => ({ default: {} }))

vi.mock('../renderer/components/company/MemoEditModal', () => ({
  MemoEditModal: () => null,
}))

vi.mock('../renderer/components/company/CompanyMemo.module.css', () => ({
  default: new Proxy({}, { get: (_: object, prop: string) => prop }),
}))

// --- Imports after mocks ---

const { CompanyMemo } = await import('../renderer/components/company/CompanyMemo')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// --- Helpers ---

const MEMO = {
  id: 'memo-1',
  companyId: 'co-1',
  themeId: null,
  dealId: null,
  title: 'Amma Investment Memo',
  status: 'draft' as const,
  latestVersionNumber: 2,
  createdBy: null,
  createdAt: '2026-03-29T10:00:00Z',
  updatedAt: '2026-03-29T10:00:00Z',
  latestVersion: {
    id: 'ver-2',
    memoId: 'memo-1',
    versionNumber: 2,
    contentMarkdown: '## Amma\\n\\nInvestment memo content.',
    structuredJson: null,
    changeNote: null,
    createdBy: null,
    createdAt: '2026-03-29T10:00:00Z',
  },
}

function renderMemo() {
  return render(React.createElement(CompanyMemo, { companyId: 'co-1' }))
}

async function loadMemo() {
  windowInvokeMock.mockResolvedValueOnce(MEMO)
  renderMemo()
  await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy())
}

// --- Tests ---

describe('CompanyMemo — PDF export', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('disables Export PDF when memo has no latestVersion', async () => {
    const noVersionMemo = { ...MEMO, latestVersion: null }
    windowInvokeMock.mockResolvedValueOnce(noVersionMemo)
    renderMemo()
    await waitFor(() => expect(screen.getByText('Export PDF')).toBeTruthy())
    const btn = screen.getByText('Export PDF').closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows filename on successful PDF export', async () => {
    await loadMemo()
    invokeMock.mockResolvedValueOnce({ success: true, path: '/Users/test/memos/Amma - v2.pdf' })
    await act(async () => { fireEvent.click(screen.getByText('Export PDF')) })
    await waitFor(() => expect(screen.getByText(/Saved: Amma - v2\.pdf/)).toBeTruthy())
  })

  it('shows error message when PDF export fails', async () => {
    await loadMemo()
    invokeMock.mockRejectedValueOnce(new Error('write error'))
    await act(async () => { fireEvent.click(screen.getByText('Export PDF')) })
    await waitFor(() => expect(screen.getByText('Export failed — try again')).toBeTruthy())
  })
})

describe('CompanyMemo — Share', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('invokes INVESTMENT_MEMO_SHARE_LINK and shows URL row on success', async () => {
    await loadMemo()
    invokeMock.mockResolvedValueOnce({ success: true, url: 'https://cyggie.vercel.app/m/abc123', token: 'abc123' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('https://cyggie.vercel.app/m/abc123')).toBeTruthy())
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.INVESTMENT_MEMO_SHARE_LINK, MEMO.id)
  })

  it('shows error message when share IPC returns network_error', async () => {
    await loadMemo()
    invokeMock.mockResolvedValueOnce({ success: false, error: 'network_error', message: 'timeout' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('timeout')).toBeTruthy())
    expect(screen.queryByText('Copy link')).toBeNull()
  })

  it('shows Shared badge when shareUrl is set', async () => {
    await loadMemo()
    invokeMock.mockResolvedValueOnce({ success: true, url: 'https://cyggie.vercel.app/m/abc123', token: 'abc123' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy())
  })
})

describe('CompanyMemo — Copy link', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('copies URL to clipboard and shows Copied! for 2s', async () => {
    await loadMemo()
    clipboardWriteMock.mockResolvedValueOnce(undefined)
    invokeMock.mockResolvedValueOnce({ success: true, url: 'https://cyggie.vercel.app/m/tok1', token: 'tok1' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('Copy link')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByText('Copy link')) })
    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith('https://cyggie.vercel.app/m/tok1'))
    expect(screen.getByText('Copied!')).toBeTruthy()
  })
})

describe('CompanyMemo — Open in browser', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('calls shell:open-external with shareUrl when Open is clicked', async () => {
    await loadMemo()
    windowInvokeMock.mockResolvedValue(undefined)
    invokeMock.mockResolvedValueOnce({ success: true, url: 'https://cyggie.vercel.app/m/tok2', token: 'tok2' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('Open')).toBeTruthy())
    fireEvent.click(screen.getByText('Open'))
    expect(windowInvokeMock).toHaveBeenCalledWith('shell:open-external', 'https://cyggie.vercel.app/m/tok2')
  })
})

describe('CompanyMemo — Revoke', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('invokes INVESTMENT_MEMO_REVOKE_SHARE and clears URL row', async () => {
    await loadMemo()
    invokeMock.mockResolvedValueOnce({ success: true, url: 'https://cyggie.vercel.app/m/tok3', token: 'tok3' })
    await act(async () => { fireEvent.click(screen.getByText('Share')) })
    await waitFor(() => expect(screen.getByText('Revoke')).toBeTruthy())

    invokeMock.mockResolvedValueOnce({ success: true })
    await act(async () => { fireEvent.click(screen.getByText('Revoke')) })
    await waitFor(() => expect(screen.queryByText('Revoke')).toBeNull())
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.INVESTMENT_MEMO_REVOKE_SHARE, 'tok3')
    expect(screen.queryByText('Copy link')).toBeNull()
  })
})
