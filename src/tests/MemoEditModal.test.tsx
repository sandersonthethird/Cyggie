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
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'
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

  it('calls INVESTMENT_MEMO_SAVE_VERSION when editor content changes', async () => {
    const { onSaved } = renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    const newContent = '## Updated Executive Summary\n\nRevised content here.'
    const savedVersion = { ...MEMO.latestVersion!, versionNumber: 3, contentMarkdown: newContent }
    invokeMock.mockResolvedValueOnce(savedVersion)

    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(newContent) }) })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        MEMO.id,
        expect.objectContaining({ contentMarkdown: newContent })
      )
    })
    expect(onSaved).toHaveBeenCalledWith(savedVersion)
  })

  it('calls INVESTMENT_MEMO_SAVE_VERSION on close when there are unsaved changes', async () => {
    const { onClose, onSaved } = renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    // Simulate user typing (sets contentDraft but debounce hasn't fired yet via auto-save)
    // We test the flush path by setting up content that differs from savedContentRef
    const pendingContent = '## New heading\n\nPending edit not yet auto-saved.'
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(pendingContent) }) })

    // Let the debounced auto-save fire and resolve
    const autoSaveVersion = { ...MEMO.latestVersion!, versionNumber: 3, contentMarkdown: pendingContent }
    invokeMock.mockResolvedValueOnce(autoSaveVersion)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    // savedContentRef.current is now pendingContent

    // Type more (not yet auto-saved)
    const flushContent = '## New heading\n\nAdditional content added just before closing.'
    invokeMock.mockResolvedValueOnce({ ...autoSaveVersion, contentMarkdown: flushContent })
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(flushContent) }) })

    // Click Done — should flush the pending flushContent change
    await act(async () => { fireEvent.click(screen.getByText('Done')) })

    // The flush save should have been called with flushContent
    expect(invokeMock).toHaveBeenLastCalledWith(
      IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
      MEMO.id,
      expect.objectContaining({ contentMarkdown: flushContent })
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('does not re-save after savedContentRef is updated by a successful auto-save', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    const content = '## Heading\n\nBody text.'
    const savedVersion = { ...MEMO.latestVersion!, versionNumber: 3, contentMarkdown: content }
    invokeMock.mockResolvedValueOnce(savedVersion)

    // First onUpdate → auto-save fires
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(content) }) })
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))

    // Second onUpdate with the same content — savedContentRef.current === content,
    // so debouncedContent === savedContentRef and no save should fire
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(content) }) })

    // Give time for any spurious effects to fire
    await new Promise((r) => setTimeout(r, 10))
    expect(invokeMock).toHaveBeenCalledTimes(1)
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
