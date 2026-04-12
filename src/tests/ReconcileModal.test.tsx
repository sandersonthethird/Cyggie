// @vitest-environment jsdom
/**
 * Tests for ReconcileModal — NoteCardEditor TipTap integration.
 *
 * Mock boundaries:
 *   - useTiptapMarkdown → captures loadContent calls; exposes onUpdate for simulation
 *   - @tiptap/react → EditorContent stub (no DOM rendering)
 *
 * Coverage:
 *   render:          note content is passed to loadContent (not rendered as raw markdown)
 *   edit:            onUpdate fires → onChange propagates new markdown to parent perCard state
 *   collapse/expand: re-mounting NoteCardEditor uses current card.noteContent (edited), not
 *                    original p.noteContent — edits are preserved across collapse cycles
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

vi.mock('@tiptap/react', () => ({ EditorContent: () => null }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))

const invokeMock = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: invokeMock },
  writable: true,
})

vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) },
}))

// --- Imports after mocks ---

const { ReconcileModal } = await import('../renderer/components/partner-meeting/ReconcileModal')

// --- Helpers ---

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'co-1',
    companyName: 'Acme Corp',
    noteTitle: 'Partner Meeting Notes',
    noteContent: '## Summary\n\n**Key takeaway:** product-market fit confirmed.',
    fieldUpdates: [],
    tasks: [],
    error: null,
    ...overrides,
  }
}

function renderModal(proposals = [makeProposal()], state: 'ready' | 'generating' | 'error' = 'ready') {
  const onConclude = vi.fn()
  const onClose = vi.fn()
  render(
    React.createElement(ReconcileModal, {
      digestId: 'digest-1',
      meetingId: 'meeting-1',
      weekOf: '2026-04-07',
      proposals,
      state,
      onConclude,
      onClose,
    })
  )
  return { onConclude, onClose }
}

function makeFakeEditor(markdown: string) {
  return { getMarkdown: () => markdown, getText: () => markdown }
}

// --- Tests ---

describe('ReconcileModal — NoteCardEditor TipTap integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnUpdate = undefined
    // Expand the first card to make the NoteCardEditor visible
    // Cards start with the first one auto-expanded (isFirst logic in ReconcileModal)
  })

  afterEach(() => {
    cleanup()
  })

  it('passes note content to loadContent (not rendered as raw markdown string)', async () => {
    const proposal = makeProposal()
    renderModal([proposal])

    await waitFor(() => {
      expect(loadContentMock).toHaveBeenCalledWith(
        '## Summary\n\n**Key takeaway:** product-market fit confirmed.'
      )
    })
  })

  it('propagates edited markdown to perCard state via onChange', async () => {
    const proposal = makeProposal()
    renderModal([proposal])

    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    const editedMarkdown = '## Summary\n\nEdited content after user review.'
    act(() => {
      capturedOnUpdate?.({ editor: makeFakeEditor(editedMarkdown) })
    })

    // Trigger Apply & Conclude — the IPC call should carry the edited content
    invokeMock.mockResolvedValueOnce({ failed: [] })
    fireEvent.click(screen.getByText('Apply & Conclude'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        expect.any(String), // PARTNER_MEETING_APPLY_RECONCILIATION channel
        expect.objectContaining({
          proposals: expect.arrayContaining([
            expect.objectContaining({ noteContent: editedMarkdown }),
          ]),
        })
      )
    })
  })

  it('initializes editor with edited noteContent (not original proposal) after collapse/re-expand', async () => {
    const proposal = makeProposal()
    renderModal([proposal])

    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())
    const firstLoadContent = loadContentMock.mock.calls[0][0]
    expect(firstLoadContent).toBe(proposal.noteContent)

    // Simulate user editing the note
    const editedMarkdown = '## Revised\n\nUser changed this.'
    act(() => {
      capturedOnUpdate?.({ editor: makeFakeEditor(editedMarkdown) })
    })

    // Collapse the card by clicking the toggle button (▾ → ▶)
    loadContentMock.mockClear()
    capturedOnUpdate = undefined
    const toggleBtn = screen.getByText(/▾/)
    fireEvent.click(toggleBtn)

    // Re-expand the card
    const collapsedToggle = screen.getByText(/▶/)
    fireEvent.click(collapsedToggle)

    // Editor remounts — loadContent must be called with the edited content, not original
    await waitFor(() => {
      expect(loadContentMock).toHaveBeenCalled()
      const reloadArg = loadContentMock.mock.calls[loadContentMock.mock.calls.length - 1][0]
      expect(reloadArg).toBe(editedMarkdown)
      expect(reloadArg).not.toBe(proposal.noteContent)
    })
  })
})
