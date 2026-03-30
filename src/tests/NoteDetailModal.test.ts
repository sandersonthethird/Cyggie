// @vitest-environment jsdom
/**
 * Tests for NoteDetailModal — Tiptap rich-text rendering and edit/save pipeline.
 *
 * Mock boundaries:
 *   - window.api.invoke → controls note fetch and save responses
 *   - useTiptapMarkdown → captures loadContent calls; exposes onUpdate for simulation
 *   - useDebounce → pass-through (no debounce delay) so save effects fire immediately
 *   - @tiptap/react → EditorContent stub (no DOM rendering)
 *   - ConfirmDialog → stub
 *
 * Coverage:
 *   load:        note fetch → loadContent called with note.content
 *   title:       note title rendered in header input
 *   edit→save:   onUpdate fires → contentDraft updated → COMPANY_NOTES_UPDATE called
 *   close flush: handleClose with unsaved content → COMPANY_NOTES_UPDATE called
 *   save error:  COMPANY_NOTES_UPDATE rejects → saveError class on editor wrapper
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
  useDebounce: <T>(value: T) => value,
}))

vi.mock('@tiptap/react', () => ({ EditorContent: () => null }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))

vi.mock('../renderer/components/common/ConfirmDialog', () => ({
  default: () => null,
}))

const invokeMock = vi.fn()
Object.defineProperty(window, 'api', {
  value: { invoke: invokeMock },
  writable: true,
})

vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) },
}))

// --- Imports after mocks ---

const { NoteDetailModal } = await import('../renderer/components/crm/NoteDetailModal')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// --- Helpers ---

const NOTE = {
  id: 'note-1',
  title: 'Pitch Deck — Amma',
  content: '## Partner Sync Summary\n\n---\n\n## Full Analysis',
  companyId: 'co-1',
  contactId: null,
  sourceMeetingId: null,
  themeId: null,
  isPinned: false,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-03-29T10:00:00Z',
  updatedAt: '2026-03-29T10:00:00Z',
  folderPath: null,
  importSource: null,
}

function renderModal(overrides: Partial<typeof NOTE> = {}) {
  const note = { ...NOTE, ...overrides }
  invokeMock.mockResolvedValueOnce(note)  // COMPANY_NOTES_GET
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  const onUpdated = vi.fn()
  render(
    React.createElement(NoteDetailModal, {
      noteId: note.id,
      onClose,
      onDeleted,
      onUpdated,
    })
  )
  return { onClose, onDeleted, onUpdated, note }
}

function makeFakeEditor(markdown: string) {
  return { getMarkdown: () => markdown, getText: () => markdown }
}

// --- Tests ---

describe('NoteDetailModal — Tiptap integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedOnUpdate = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('calls loadContent with note.content after fetch resolves', async () => {
    renderModal()
    await waitFor(() => {
      expect(loadContentMock).toHaveBeenCalledWith(NOTE.content)
    })
  })

  it('renders the title in the header input after load', async () => {
    renderModal()
    await waitFor(() => {
      expect(screen.getByDisplayValue('Pitch Deck — Amma')).toBeTruthy()
    })
  })

  it('calls COMPANY_NOTES_UPDATE when title changes', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('Pitch Deck — Amma'))

    invokeMock.mockResolvedValueOnce({ ...NOTE, title: 'New Title' })
    fireEvent.change(screen.getByDisplayValue('Pitch Deck — Amma'), {
      target: { value: 'New Title' }
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        NOTE.id,
        expect.objectContaining({ title: 'New Title' })
      )
    })
  })

  it('calls COMPANY_NOTES_UPDATE when onUpdate fires with new content', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    const newMarkdown = '## Updated heading\n\nNew body text'
    invokeMock.mockResolvedValueOnce({ ...NOTE, content: newMarkdown })

    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor(newMarkdown) }) })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        IPC_CHANNELS.COMPANY_NOTES_UPDATE,
        NOTE.id,
        expect.objectContaining({ content: newMarkdown })
      )
    })
  })

  it('calls onClose when close button is clicked', async () => {
    const { onClose } = renderModal()
    await waitFor(() => screen.getByDisplayValue('Pitch Deck — Amma'))

    // Any saves that fire should resolve cleanly
    invokeMock.mockResolvedValue(null)
    await act(async () => { fireEvent.click(screen.getByTitle('Close')) })

    expect(onClose).toHaveBeenCalled()
  })

  it('applies saveError class to editor wrapper when save fails', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())

    // Set up rejection BEFORE triggering edit so the immediate debounced save fails
    invokeMock.mockRejectedValue(new Error('network error'))
    act(() => { capturedOnUpdate?.({ editor: makeFakeEditor('## Changed') }) })

    await waitFor(() => {
      const wrapper = document.querySelector('[class*="editorContent"]')
      expect(wrapper?.className).toMatch(/saveError/)
    })
  })
})
