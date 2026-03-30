// @vitest-environment jsdom
/**
 * Tests for NoteDetail component — focused on the MEETING_GET failure path.
 *
 * Mock boundaries:
 *   - react-router-dom → stub useParams / useNavigate
 *   - useNoteEditor → returns a pre-loaded note with sourceMeetingId set
 *   - api.invoke → mocked; MEETING_GET configured to throw in failure test
 *   - @tiptap/react → minimal stub (no DOM rendering)
 *   - child components → stub (NoteTagger, TagSuggestionBanner, TiptapBubbleMenu)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import React from 'react'

// --- Mocks ---

vi.mock('react-router-dom', () => ({
  useParams: vi.fn(() => ({ id: 'note-1' })),
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('../renderer/api', () => ({
  api: { invoke: vi.fn() },
}))

vi.mock('../renderer/hooks/useNoteEditor', () => ({
  useNoteEditor: vi.fn(),
}))

vi.mock('../renderer/hooks/useEditableTitle', () => ({
  useEditableTitle: () => ({
    editingTitle: false,
    titleRef: { current: null },
    handleTitleClick: vi.fn(),
    handleTitleBlur: vi.fn(),
    handleTitleKeyDown: vi.fn(),
  }),
}))

vi.mock('../renderer/components/notes/NoteTagger', () => ({
  NoteTagger: () => null,
}))

vi.mock('../renderer/components/notes/TagSuggestionBanner', () => ({
  TagSuggestionBanner: () => null,
}))

vi.mock('../renderer/components/common/TiptapBubbleMenu', () => ({
  TiptapBubbleMenu: () => null,
}))

vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => null),
  EditorContent: () => null,
}))

vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('@tiptap/extension-image', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))

// --- Imports after mocks ---

const { NoteDetailLoaded } = await import('../renderer/routes/NoteDetail')
const { useNoteEditor } = await import('../renderer/hooks/useNoteEditor')
const { api } = await import('../renderer/api')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// --- Helpers ---

function makeLoadedHookState(overrides: Record<string, unknown> = {}) {
  return {
    note: {
      id: 'note-1',
      title: 'Test Note',
      content: '',
      companyId: null,
      contactId: null,
      sourceMeetingId: 'meeting-1',
      themeId: null,
      isPinned: false,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: '2026-03-24T10:00:00Z',
      updatedAt: '2026-03-24T10:00:00Z',
      folderPath: null,
      importSource: null,
      companyName: null,
      contactName: null,
      ...overrides,
    },
    loadState: 'loaded',
    titleDraft: 'Test Note',
    setTitleDraft: vi.fn(),
    editor: null,
    saveStatus: 'saved',
    isPinned: false,
    setIsPinned: vi.fn(),
    tagSuggestion: null,
    dismissSuggestion: vi.fn(),
    deleteNote: vi.fn(),
  }
}

// --- Tests ---

describe('NoteDetail — source meeting chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useNoteEditor).mockReturnValue(makeLoadedHookState() as ReturnType<typeof useNoteEditor>)
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the meeting chip when MEETING_GET succeeds', async () => {
    vi.mocked(api.invoke).mockResolvedValueOnce({ title: 'AYR Board Meeting' })

    render(React.createElement(NoteDetailLoaded))

    await waitFor(() => {
      expect(screen.getByText(/AYR Board Meeting/)).toBeTruthy()
    })
  })

  it('suppresses the meeting chip when MEETING_GET throws — no crash', async () => {
    vi.mocked(api.invoke).mockRejectedValueOnce(new Error('Meeting not found'))

    // Should not throw
    render(React.createElement(NoteDetailLoaded))

    await waitFor(() => {
      // Chip should not be rendered
      expect(screen.queryByTitle('View source meeting')).toBeNull()
    })
  })

  it('suppresses the meeting chip when note has no sourceMeetingId', async () => {
    vi.mocked(useNoteEditor).mockReturnValue(
      makeLoadedHookState({ sourceMeetingId: null }) as ReturnType<typeof useNoteEditor>
    )
    // MEETING_GET should never be called
    render(React.createElement(NoteDetailLoaded))

    await waitFor(() => {
      expect(api.invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.MEETING_GET, expect.anything())
    })
  })
})
