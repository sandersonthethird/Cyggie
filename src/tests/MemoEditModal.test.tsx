// @vitest-environment jsdom
/**
 * Tests for MemoEditModal — Tiptap rich-text editor with auto-save.
 *
 * Mock boundaries:
 *   - useTiptapMarkdown → captures loadContent calls; exposes onUpdate for simulation
 *   - useDebounce → pass-through (no delay) so save effects fire immediately
 *   - @tiptap/react → EditorContent stub (no DOM rendering)
 *   - api.invoke → controls save responses
 *   - TiptapBubbleMenu → stub
 *
 * Coverage diagram:
 *
 *   load:          modal mounts → loadContent(memo.latestVersion.contentMarkdown)
 *   auto-save:     onUpdate fires → contentDraft changes → INVESTMENT_MEMO_SAVE_VERSION called
 *   flush-on-close: Done clicked with pending changes → INVESTMENT_MEMO_SAVE_VERSION called
 *   no-dup-save:   after save updates savedContentRef, same content doesn't re-trigger save
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent, within } from '@testing-library/react'
import React from 'react'

// --- Mocks ---

const loadContentMock = vi.fn()
let capturedOnUpdate: ((args: { editor: unknown }) => void) | undefined

vi.mock('../renderer/hooks/useTiptapMarkdown', () => ({
  useTiptapMarkdown: vi.fn((options: { onUpdate?: (args: { editor: unknown }) => void }) => {
    capturedOnUpdate = options.onUpdate
    return { editor: null, loadContent: loadContentMock, isLoaded: false }
  }),
}))

// Pass-through debounce so save effects fire immediately in tests
vi.mock('../renderer/hooks/useDebounce', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useDebounce: (value: any) => value,
}))

vi.mock('@tiptap/react', () => ({ EditorContent: () => null }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: {} }))

// useNotice throws if not wrapped in NoticeModalProvider; stub for tests.
vi.mock('../renderer/components/common/NoticeModal', () => ({
  useNotice: () => ({ show: vi.fn() }),
  NoticeModalProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// useRuns / useRunForCompany throw if not wrapped in RunsProvider; stub for tests.
vi.mock('../renderer/contexts/RunsContext', () => ({
  useRuns: () => ({ runs: {}, dismissRun: vi.fn(), startRun: vi.fn(), appendEvent: vi.fn(), completeRun: vi.fn() }),
  useRunForCompany: () => null,
  RunsProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('../renderer/components/common/TiptapBubbleMenu', () => ({
  TiptapBubbleMenu: () => null,
}))

vi.mock('../renderer/components/company/MemoEditModal.module.css', () => ({
  default: new Proxy({}, { get: (_: object, prop: string) => prop }),
}))

const invokeMock = vi.fn()
vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) },
}))

// --- Imports after mocks ---

const { MemoEditModal } = await import('../renderer/components/company/MemoEditModal')
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
    contentMarkdown: '## Amma Investment Memo\n\n### Executive Summary\n\nAmma is an AI-powered care coordination platform.',
    structuredJson: null,
    changeNote: null,
    createdBy: null,
    createdAt: '2026-03-29T10:00:00Z',
  },
}

function makeFakeEditor(markdown: string) {
  return { getMarkdown: () => markdown }
}

function renderModal(overrides: Partial<typeof MEMO> = {}) {
  const memo = { ...MEMO, ...overrides }
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(
    React.createElement(MemoEditModal, { memo, onSaved, onClose })
  )
  return { memo, onSaved, onClose }
}

// --- Tests ---

describe('MemoEditModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnUpdate = undefined
  })

  afterEach(cleanup)

  it('calls loadContent with memo.latestVersion.contentMarkdown on mount', async () => {
    renderModal()
    await waitFor(() => {
      expect(loadContentMock).toHaveBeenCalledWith(MEMO.latestVersion!.contentMarkdown)
    })
  })

  // Production removed auto-save in favor of explicit Save (button or ⌘S)
  // and a confirm-discard dialog on close-while-dirty. These tests verify
  // the new flow.
  it('fires INVESTMENT_MEMO_SAVE_VERSION when the Save button is clicked after content changes', async () => {
    const { onSaved } = renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    const newContent = '## Updated Executive Summary\n\nRevised content here.'
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(newContent) }) })

    const savedVersion = { ...MEMO.latestVersion!, versionNumber: 3, contentMarkdown: newContent }
    invokeMock.mockResolvedValueOnce(savedVersion)

    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        MEMO.id,
        expect.objectContaining({ contentMarkdown: newContent })
      )
    })
    expect(onSaved).toHaveBeenCalledWith(savedVersion)
  })

  it('fires INVESTMENT_MEMO_SAVE_VERSION when the confirm-discard dialog Save is clicked', async () => {
    const { onClose, onSaved } = renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    // User types — contentDraft now differs from savedContentRef
    const pendingContent = '## New heading\n\nUnsaved edit.'
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(pendingContent) }) })

    // Click Done → confirm-discard dialog opens
    await act(async () => { fireEvent.click(screen.getByText('Done')) })

    const dialog = screen.getByRole('dialog', { name: 'Unsaved changes' })
    const dialogSaveBtn = within(dialog).getByText('Save')

    const savedVersion = { ...MEMO.latestVersion!, versionNumber: 3, contentMarkdown: pendingContent }
    invokeMock.mockResolvedValueOnce(savedVersion)

    await act(async () => { fireEvent.click(dialogSaveBtn) })

    expect(invokeMock).toHaveBeenCalledWith(
      IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
      MEMO.id,
      expect.objectContaining({ contentMarkdown: pendingContent })
    )
    expect(onSaved).toHaveBeenCalledWith(savedVersion)
    expect(onClose).toHaveBeenCalled()
  })

  it('Save button is disabled when content matches the last-saved snapshot', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    // No edits → contentDraft === savedContentRef → isDirty=false → button disabled.
    // This is the new-flow equivalent of the old "no re-save when content matches
    // savedContentRef" invariant — handleSave early-returns when !isDirty, and the
    // button itself surfaces that gate.
    const saveBtn = screen.getByText('Save').closest('button') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('renders null when latestVersion is null', () => {
    const { container } = render(
      React.createElement(MemoEditModal, {
        memo: { ...MEMO, latestVersion: null },
        onSaved: vi.fn(),
        onClose: vi.fn(),
      })
    )
    expect(container.firstChild).toBeNull()
  })
})
