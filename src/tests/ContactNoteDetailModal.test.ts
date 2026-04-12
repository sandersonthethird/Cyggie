// @vitest-environment jsdom
/**
 * Tests for ContactNoteDetailModal — mirrors NoteDetailModal coverage.
 *
 * Mock boundaries:
 *   - window.api.invoke / api.invoke → controls note fetch and save responses
 *   - useTiptapMarkdown → captures loadContent calls; exposes onUpdate for simulation
 *   - useDebounce → pass-through (no debounce delay) so save effects fire immediately
 *   - @tiptap/react → EditorContent stub
 *   - ConfirmDialog, FindBar → stubs
 *   - react-router-dom → stub useNavigate
 *   - useNoteShareMenu → stub
 *
 * Coverage:
 *   load:         note fetch → loadContent called with note.content
 *   title:        note title rendered in header input
 *   open meeting: sourceMeetingId set → "Open Meeting →" visible; click navigates + closes
 *   no meeting:   sourceMeetingId null → "Open Meeting →" not rendered
 *   share:        "Share ▾" button always rendered when loaded
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

vi.mock('../renderer/hooks/useTiptapMarkdown', () => ({
  useTiptapMarkdown: vi.fn((options: { onUpdate?: (args: { editor: unknown }) => void }) => {
    return { editor: null, loadContent: loadContentMock, isLoaded: false }
  }),
}))

vi.mock('../renderer/hooks/useDebounce', () => ({
  useDebounce: <T>(value: T) => value,
}))

vi.mock('@tiptap/react', () => ({ EditorContent: () => null }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))

vi.mock('../renderer/components/common/ConfirmDialog', () => ({
  default: () => null,
}))

vi.mock('../renderer/hooks/useFindInPage', () => ({
  useFindInPage: vi.fn(() => ({
    query: '', setQuery: vi.fn(), matchCount: 0, activeMatchIndex: 0,
    goToNext: vi.fn(), goToPrev: vi.fn(),
  })),
}))
vi.mock('../renderer/components/common/FindBar', () => ({ default: () => null }))

vi.mock('../renderer/hooks/useNoteShareMenu', () => ({
  useNoteShareMenu: vi.fn(() => ({
    shareMenuOpen: false,
    setShareMenuOpen: vi.fn(),
    shareMenuRef: { current: null },
    canShare: true,
    handleCopyText: vi.fn(),
    handleWebShare: vi.fn(),
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

const { ContactNoteDetailModal } = await import('../renderer/components/crm/ContactNoteDetailModal')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// --- Helpers ---

const NOTE = {
  id: 'cnote-1',
  title: 'Follow-up Notes',
  content: 'Discussed funding and roadmap.',
  companyId: null,
  contactId: 'contact-1',
  sourceMeetingId: null as string | null,
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
  invokeMock.mockResolvedValueOnce(note)  // CONTACT_NOTES_GET
  const onClose = vi.fn()
  const onDeleted = vi.fn()
  const onUpdated = vi.fn()
  render(
    React.createElement(ContactNoteDetailModal, {
      noteId: note.id,
      onClose,
      onDeleted,
      onUpdated,
    })
  )
  return { onClose, onDeleted, onUpdated, note }
}

// --- Tests ---

describe('ContactNoteDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      expect(screen.getByDisplayValue('Follow-up Notes')).toBeTruthy()
    })
  })

  it('renders "Open Meeting →" when sourceMeetingId is set', async () => {
    renderModal({ sourceMeetingId: 'meeting-42' })
    await waitFor(() => screen.getByDisplayValue('Follow-up Notes'))
    expect(screen.getByText('Open Meeting →')).toBeTruthy()
  })

  it('does not render "Open Meeting →" when sourceMeetingId is null', async () => {
    renderModal({ sourceMeetingId: null })
    await waitFor(() => screen.getByDisplayValue('Follow-up Notes'))
    expect(screen.queryByText('Open Meeting →')).toBeNull()
  })

  it('navigates to meeting and closes when "Open Meeting →" is clicked', async () => {
    const { onClose } = renderModal({ sourceMeetingId: 'meeting-42' })
    await waitFor(() => screen.getByText('Open Meeting →'))

    invokeMock.mockResolvedValue(null)
    fireEvent.click(screen.getByText('Open Meeting →'))

    expect(navigateMock).toHaveBeenCalledWith('/meeting/meeting-42')
    expect(onClose).toHaveBeenCalled()
  })

  it('renders "Share ▾" button when note is loaded', async () => {
    renderModal()
    await waitFor(() => screen.getByDisplayValue('Follow-up Notes'))
    expect(screen.getByText('Share ▾')).toBeTruthy()
  })

  it('fetches note via CONTACT_NOTES_GET on mount', async () => {
    renderModal()
    await waitFor(() => expect(loadContentMock).toHaveBeenCalled())
    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.CONTACT_NOTES_GET, NOTE.id)
  })
})
