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
    expect(filesCalls[0]).toEqual([IPC_CHANNELS.COMPANY_FILES, 'company-1', undefined])
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

  it('surfaces a clear error when the handler returns the legacy boolean shape', async () => {
    // Simulates a stale main process running the pre-validation handler that
    // returned a bare boolean. Without the strict guard, the renderer used to
    // silently no-op (setFlagError(undefined) → JSX guard hides it).
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: MOCK_FILES, companyRoot: '/root' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) return Promise.resolve(true)
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Amma - Term Sheet.pdf'))

    fireEvent.click(screen.getByTitle('Include in chat context'))

    await waitFor(() => screen.getByText(/unexpected response/i))
    // Icon should still be the empty star — no state change on bad shape.
    expect(screen.getByTitle('Include in chat context')).toBeTruthy()
  })
})

// ── Folder navigation ──────────────────────────────────────────────────────

const FOLDER_REPORTS = {
  id: '/root/Amma/Reports',
  name: 'Reports',
  mimeType: 'folder',
  modifiedAt: null,
  webViewLink: null,
  sizeBytes: null,
  parentFolderName: 'Amma',
}

const FOLDER_MEMOS = {
  id: '/root/Amma/Memos',
  name: 'Memos',
  mimeType: 'folder',
  modifiedAt: null,
  webViewLink: null,
  sizeBytes: null,
  parentFolderName: 'Amma',
}

const FOLDER_Q2 = {
  id: '/root/Amma/Reports/Q2',
  name: 'Q2',
  mimeType: 'folder',
  modifiedAt: null,
  webViewLink: null,
  sizeBytes: null,
  parentFolderName: 'Reports',
}

const FILE_TERM_SHEET = {
  id: '/root/Amma/Reports/term-sheet.pdf',
  name: 'term-sheet.pdf',
  mimeType: 'pdf',
  modifiedAt: null,
  webViewLink: null,
  sizeBytes: null,
  parentFolderName: 'Reports',
}

const FILE_Q2_PDF = {
  id: '/root/Amma/Reports/Q2/q2-pricing.pdf',
  name: 'q2-pricing.pdf',
  mimeType: 'pdf',
  modifiedAt: null,
  webViewLink: null,
  sizeBytes: null,
  parentFolderName: 'Q2',
}

describe('CompanyFiles folder navigation', () => {
  it('double-click on a folder calls IPC with browsePath and updates the listing', async () => {
    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve(
          browsePath === FOLDER_REPORTS.id
            ? { files: [FILE_TERM_SHEET], companyRoot: '/root/Amma' }
            : { files: [FOLDER_REPORTS], companyRoot: '/root/Amma' }
        )
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))

    fireEvent.doubleClick(screen.getByText('Reports'))

    await waitFor(() => screen.getByText('term-sheet.pdf'))
    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(2)
    expect(filesCalls[1][2]).toBe(FOLDER_REPORTS.id)
  })

  it('single-click on a folder is a no-op (does not navigate, does not open)', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: [FOLDER_REPORTS], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))

    fireEvent.click(screen.getByText('Reports'))

    // Wait a tick so any errant IPC call has time to fire.
    await new Promise((r) => setTimeout(r, 0))
    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(1)
    // Reports row should still be visible (no navigation, no open).
    expect(screen.getByText('Reports')).toBeTruthy()
  })

  it('breadcrumb "Files" click returns to root', async () => {
    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve(
          browsePath === FOLDER_REPORTS.id
            ? { files: [FILE_TERM_SHEET], companyRoot: '/root/Amma' }
            : { files: [FOLDER_REPORTS], companyRoot: '/root/Amma' }
        )
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))
    fireEvent.doubleClick(screen.getByText('Reports'))
    await waitFor(() => screen.getByText('term-sheet.pdf'))

    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    // Returning to root hits the cache (set on the initial mount), so no
    // new IPC fires — but the Reports row reappears from cached state.
    await waitFor(() => screen.getByText('Reports'))
    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls).toHaveLength(2)
    expect(filesCalls[1][2]).toBe(FOLDER_REPORTS.id)
  })

  it('↑ Back button pops one level', async () => {
    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        if (browsePath === FOLDER_Q2.id) {
          return Promise.resolve({ files: [FILE_Q2_PDF], companyRoot: '/root/Amma' })
        }
        if (browsePath === FOLDER_REPORTS.id) {
          return Promise.resolve({ files: [FOLDER_Q2, FILE_TERM_SHEET], companyRoot: '/root/Amma' })
        }
        return Promise.resolve({ files: [FOLDER_REPORTS], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))
    fireEvent.doubleClick(screen.getByText('Reports'))
    await waitFor(() => screen.getByText('Q2'))
    fireEvent.doubleClick(screen.getByText('Q2'))
    await waitFor(() => screen.getByText('q2-pricing.pdf'))

    fireEvent.click(screen.getByRole('button', { name: '↑ Back' }))

    await waitFor(() => screen.getByText('term-sheet.pdf'))
    // Breadcrumb should be Files / Reports — Q2 must NOT be present.
    expect(screen.queryByRole('button', { name: 'Q2' })).toBeNull()
  })

  it('refresh in a subfolder refetches the subfolder, not the root', async () => {
    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve(
          browsePath === FOLDER_REPORTS.id
            ? { files: [FILE_TERM_SHEET], companyRoot: '/root/Amma' }
            : { files: [FOLDER_REPORTS], companyRoot: '/root/Amma' }
        )
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))
    fireEvent.doubleClick(screen.getByText('Reports'))
    await waitFor(() => screen.getByText('term-sheet.pdf'))

    fireEvent.click(screen.getByTitle('Refresh files'))

    await waitFor(() => {
      const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
      expect(filesCalls).toHaveLength(3)
    })
    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    expect(filesCalls[2][2]).toBe(FOLDER_REPORTS.id)
  })

  it('rejects a stale response from a prior navigation (race fix)', async () => {
    // Scenario: dbl-click Reports (long-pending), then click "Files" breadcrumb
    // back to root. Root resolves and re-renders. Then the stale Reports
    // response finally resolves — its payload must be discarded by the
    // cancelled flag, otherwise it would clobber the root listing.
    let resolveReports: ((v: unknown) => void) | null = null
    const reportsPromise = new Promise((r) => { resolveReports = r })

    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        if (browsePath === FOLDER_REPORTS.id) return reportsPromise
        return Promise.resolve({ files: [FOLDER_REPORTS, FOLDER_MEMOS], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))

    // Drill into Reports — promise stays pending, listing is now empty/loading.
    fireEvent.doubleClick(screen.getByText('Reports'))
    // Hit "Files" breadcrumb to bounce back to root before Reports resolves.
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))

    // Root re-renders with Reports + Memos.
    await waitFor(() => screen.getByText('Memos'))
    expect(screen.getByText('Reports')).toBeTruthy()

    // Now the stale Reports response lands. Without the cancelled flag, it
    // would call setFiles([term-sheet.pdf]) and clobber the root listing.
    resolveReports!({ files: [FILE_TERM_SHEET], companyRoot: '/root/Amma' })
    await new Promise((r) => setTimeout(r, 10))

    // Root listing must be intact — stale payload was discarded.
    expect(screen.getByText('Reports')).toBeTruthy()
    expect(screen.getByText('Memos')).toBeTruthy()
    expect(screen.queryByText('term-sheet.pdf')).toBeNull()
  })

  it('mid-stack breadcrumb crumb click pops to that level', async () => {
    mockInvoke.mockImplementation((channel: string, _id: string, browsePath?: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        if (browsePath === FOLDER_Q2.id) {
          return Promise.resolve({ files: [FILE_Q2_PDF], companyRoot: '/root/Amma' })
        }
        if (browsePath === FOLDER_REPORTS.id) {
          return Promise.resolve({ files: [FOLDER_Q2, FILE_TERM_SHEET], companyRoot: '/root/Amma' })
        }
        return Promise.resolve({ files: [FOLDER_REPORTS], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Reports'))
    fireEvent.doubleClick(screen.getByText('Reports'))
    await waitFor(() => screen.getByText('Q2'))
    fireEvent.doubleClick(screen.getByText('Q2'))
    await waitFor(() => screen.getByText('q2-pricing.pdf'))

    // Click the "Reports" breadcrumb segment — Q2 is the current (disabled) crumb.
    // The "Reports" breadcrumb is the only enabled "Reports" button at this point.
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }))

    await waitFor(() => screen.getByText('term-sheet.pdf'))
    const filesCalls = mockInvoke.mock.calls.filter(([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILES)
    // Last call must be the Reports browsePath (not Q2, not root).
    expect(filesCalls[filesCalls.length - 1][2]).toBe(FOLDER_REPORTS.id)
    // Q2 must no longer be in the breadcrumb.
    expect(screen.queryByRole('button', { name: 'Q2' })).toBeNull()
  })
})

// ── Phase 2: Google Drive native files ────────────────────────────────────

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

const NATIVE_DOC = {
  id: '1ABC_doc',
  name: 'Q2 partner memo',
  mimeType: GOOGLE_DOC_MIME,
  modifiedAt: null,
  webViewLink: 'https://docs.google.com/document/d/1ABC_doc',
  sizeBytes: null,
  parentFolderName: 'Amma',
}

const NATIVE_SHEET = {
  id: '1ABC_sheet',
  name: 'Cap table',
  mimeType: GOOGLE_SHEET_MIME,
  modifiedAt: null,
  webViewLink: 'https://docs.google.com/spreadsheets/d/1ABC_sheet',
  sizeBytes: null,
  parentFolderName: 'Amma',
}

describe('CompanyFiles Google native files (phase 2)', () => {
  it('renders a star toggle on a Google Doc row', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: [NATIVE_DOC], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText(/Q2 partner memo/))
    // The Doc has no extension; the star must show because mimeType is Google native.
    expect(screen.getByTitle('Include in chat context')).toBeTruthy()
  })

  it('sends mimeType in COMPANY_FILE_FLAG_TOGGLE payload for Google native files', async () => {
    mockInvoke.mockImplementation((channel: string, payload: unknown) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: [NATIVE_SHEET], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) {
        // Capture the payload for assertion.
        return Promise.resolve({ ok: true, flagged: true, _capturedPayload: payload })
      }
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Cap table'))
    fireEvent.click(screen.getByTitle('Include in chat context'))
    await waitFor(() => screen.getByTitle('Remove from chat context'))

    const toggleCall = mockInvoke.mock.calls.find(
      ([ch]: [string]) => ch === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE,
    )
    expect(toggleCall).toBeDefined()
    expect(toggleCall![1]).toEqual({
      companyId: 'company-1',
      fileId: '1ABC_sheet',
      fileName: 'Cap table',
      mimeType: GOOGLE_SHEET_MIME,
    })
  })

  it('renders the Reconnect Google Drive banner on DRIVE_SCOPE_INSUFFICIENT', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.COMPANY_FILES) {
        return Promise.resolve({ files: [NATIVE_DOC], companyRoot: '/root/Amma' })
      }
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_GET) return Promise.resolve([])
      if (channel === IPC_CHANNELS.COMPANY_FILE_FLAG_TOGGLE) {
        return Promise.resolve({
          ok: false,
          code: 'DRIVE_SCOPE_INSUFFICIENT',
          message: 'Reconnect Google Drive…',
        })
      }
      return Promise.resolve(undefined)
    })

    render(React.createElement(CompanyFiles, { companyId: 'company-1' }))
    await waitFor(() => screen.getByText('Q2 partner memo'))
    fireEvent.click(screen.getByTitle('Include in chat context'))

    await waitFor(() => screen.getByRole('button', { name: 'Reconnect Google Drive' }))
    // The icon stays as ☆ — flag was rejected because of scope.
    expect(screen.getByTitle('Include in chat context')).toBeTruthy()
  })
})
