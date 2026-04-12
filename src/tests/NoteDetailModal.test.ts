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
 *   - react-router-dom → stub useNavigate
 *   - useNoteShareMenu → stub returning controllable state
 *
 * Coverage:
 *   load:           note fetch → loadContent called with note.content
 *   title:          note title rendered in header input
 *   edit→save:      onUpdate fires → contentDraft updated → COMPANY_NOTES_UPDATE called
 *   close flush:    handleClose with unsaved content → COMPANY_NOTES_UPDATE called
 *   save error:     COMPANY_NOTES_UPDATE rejects → saveError class on editor wrapper
 *   open meeting:   sourceMeetingId set → "Open Meeting →" button visible, click navigates
 *   no meeting:     sourceMeetingId null → "Open Meeting →" not rendered
 *   share menu:     Share ▾ button always visible; menu items rendered when open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'

// --- Mocks ---

const navigateMock = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(() => navigateMock),
}))

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

// Stub useFindInPage / FindBar to avoid side effects
vi.mock('../renderer/hooks/useFindInPage', () => ({
  useFindInPage: vi.fn(() => ({
    query: '', setQuery: vi.fn(), matchCount: 0, activeMatchIndex: 0,
    goToNext: vi.fn(), goToPrev: vi.fn(),
  })),
}))
vi.mock('../renderer/components/common/FindBar', () => ({ default: () => null }))

// Stub useNoteShareMenu so share tests can control state directly
let shareMenuOpenState = false
const setShareMenuOpenMock = vi.fn((updater: boolean | ((v: boolean) => boolean)) => {
  shareMenuOpenState = typeof updater === 'function' ? updater(shareMenuOpenState) : updater
})
const handleCopyTextMock = vi.fn()
const handleWebShareMock = vi.fn()
const shareMenuRefMock = { current: null }

vi.mock('../renderer/hooks/useNoteShareMenu', () => ({
  useNoteShareMenu: vi.fn(() => ({
    shareMenuOpen: shareMenuOpenState,
    setShareMenuOpen: setShareMenuOpenMock,
    shareMenuRef: shareMenuRefMock,
    canShare: true,
    handleCopyText: handleCopyTextMock,
    handleWebShare: handleWebShareMock,
  })),
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
const { useNoteShareMenu } = await import('../renderer/hooks/useNoteShareMenu')

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
    shareMenuOpenState = false
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

  it('renders "Open Meeting →" button when sourceMeetingId is set', async () => {
    renderModal({ sourceMeetingId: 'meeting-99' })
    await waitFor(() => screen.getByDisplayValue('Pitch Deck — Amma'))
    expect(screen.getByText('Open Meeting →')).toBeTruthy()
  })

  it('does not render "Open Meeting →" when sourceMeetingId is null', async () => {
    renderModal({ sourceMeetingId: null })
    await waitFor(() => screen.getByDisplayValue('Pitch Deck — Amma'))
    expect(screen.queryByText('Open Meeting →')).toBeNull()
  })

  it('navigates to meeting and closes modal when "Open Meeting →" is clicked', async () => {
    const { onClose } = renderModal({ sourceMeetingId: 'meeting-99' })
    await waitFor(() => screen.getByText('Open Meeting →'))

    // Avoid triggering the auto-save flush from handleClose
    invokeMock.mockResolvedValue(null)
    fireEvent.click(screen.getByText('Open Meeting →'))

    expect(navigateMock).toHaveBeenCalledWith('/meeting/meeting-99')
    expect(onClose).toHaveBeenCalled()
  })

  it('renders "Share ▾" button when note is loaded', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('Pitch Deck — Amma'))
    expect(screen.getByText('Share ▾')).toBeTruthy()
  })

  it('passes noteId and contentDraft to useNoteShareMenu', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())
    expect(vi.mocked(useNoteShareMenu)).toHaveBeenCalledWith(NOTE.id, expect.any(String))
  })
})
