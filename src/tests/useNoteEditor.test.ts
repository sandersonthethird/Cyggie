// @vitest-environment jsdom
/**
 * Tests for useNoteEditor hook.
 *
 * Mock boundaries:
 *   - api.invoke → vi.fn() (returns Note stubs)
 *   - useDebounce → pass-through (synchronous)
 *   - @tiptap/react → minimal stub (no DOM rendering needed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// --- Mocks (set up before importing the hook) ---

vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn(),
    on: vi.fn(() => () => {}),
  }
}))

vi.mock('../renderer/hooks/useDebounce', () => ({
  useDebounce: <T>(value: T) => value,  // synchronous: no delay
}))

const mockEditor = {
  commands: { setContent: vi.fn(), focus: vi.fn() },
  setEditable: vi.fn(),
  getText: vi.fn(() => ''),
  storage: { markdown: { getMarkdown: vi.fn(() => '') } },
}
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => mockEditor),
  EditorContent: () => null,
}))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('@tiptap/extension-image', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))

// --- Import after mocks ---

const { useNoteEditor } = await import('../renderer/hooks/useNoteEditor')
const { api } = await import('../renderer/api')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

// Helper: minimal Note stub
function makeNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'note-1',
    title: 'Test Note',
    content: 'Hello world',
    companyId: null,
    contactId: null,
    sourceMeetingId: null,
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
  }
}

describe('useNoteEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEditor.commands.setContent.mockReset()
    mockEditor.setEditable.mockReset()
    mockEditor.storage.markdown.getMarkdown.mockReturnValue('')
  })

  it('calls NOTES_GET on mount with the correct noteId', async () => {
    const note = makeNote()
    vi.mocked(api.invoke).mockResolvedValueOnce(note)

    renderHook(() => useNoteEditor('note-1'))

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(IPC_CHANNELS.NOTES_GET, 'note-1')
    })
  })

  it('sets loadState to "loaded" and populates titleDraft after successful load', async () => {
    const note = makeNote({ title: 'My Title' })
    vi.mocked(api.invoke).mockResolvedValueOnce(note)

    const { result } = renderHook(() => useNoteEditor('note-1'))

    await waitFor(() => {
      expect(result.current.loadState).toBe('loaded')
      expect(result.current.titleDraft).toBe('My Title')
    })
  })

  it('sets loadState to "notFound" when NOTES_GET returns null', async () => {
    vi.mocked(api.invoke).mockResolvedValueOnce(null)

    const { result } = renderHook(() => useNoteEditor('note-1'))

    await waitFor(() => {
      expect(result.current.loadState).toBe('notFound')
    })
  })

  it('sets loadState to "error" when NOTES_GET throws', async () => {
    vi.mocked(api.invoke).mockRejectedValueOnce(new Error('DB error'))

    const { result } = renderHook(() => useNoteEditor('note-1'))

    await waitFor(() => {
      expect(result.current.loadState).toBe('error')
    })
  })

  it('calls NOTES_UPDATE when titleDraft changes (debounce is synchronous in tests)', async () => {
    const note = makeNote({ title: 'Old Title' })
    const updatedNote = makeNote({ title: 'New Title' })
    vi.mocked(api.invoke)
      .mockResolvedValueOnce(note)     // NOTES_GET
      .mockResolvedValueOnce(updatedNote)  // NOTES_UPDATE

    const { result } = renderHook(() => useNoteEditor('note-1'))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    act(() => { result.current.setTitleDraft('New Title') })

    await waitFor(() => {
      expect(api.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.NOTES_UPDATE,
        'note-1',
        expect.objectContaining({ title: 'New Title' })
      )
    })
  })

  it('calls onNoteUpdated callback after successful NOTES_UPDATE', async () => {
    const note = makeNote()
    const updatedNote = makeNote({ title: 'Updated' })
    vi.mocked(api.invoke)
      .mockResolvedValueOnce(note)
      .mockResolvedValueOnce(updatedNote)

    const onNoteUpdated = vi.fn()
    const { result } = renderHook(() => useNoteEditor('note-1', { onNoteUpdated }))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    act(() => { result.current.setTitleDraft('Updated') })

    await waitFor(() => {
      expect(onNoteUpdated).toHaveBeenCalledWith(updatedNote)
    })
  })

  it('sets saveStatus to "error" when NOTES_UPDATE fails', async () => {
    const note = makeNote()
    vi.mocked(api.invoke)
      .mockResolvedValueOnce(note)
      .mockRejectedValueOnce(new Error('update failed'))

    const { result } = renderHook(() => useNoteEditor('note-1'))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    act(() => { result.current.setTitleDraft('Something new') })

    await waitFor(() => {
      expect(result.current.saveStatus).toBe('error')
    })
  })

  it('deleteNote() calls NOTES_DELETE and invokes onNoteDeleted', async () => {
    const note = makeNote()
    vi.mocked(api.invoke)
      .mockResolvedValueOnce(note)   // NOTES_GET
      .mockResolvedValueOnce(true)   // NOTES_DELETE

    const onNoteDeleted = vi.fn()
    const { result } = renderHook(() => useNoteEditor('note-1', { onNoteDeleted }))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    await act(async () => { await result.current.deleteNote() })

    expect(api.invoke).toHaveBeenCalledWith(IPC_CHANNELS.NOTES_DELETE, 'note-1')
    expect(onNoteDeleted).toHaveBeenCalledWith('note-1')
  })

  it('does NOT call NOTES_DELETE on unmount when note has content', async () => {
    const note = makeNote({ content: 'Non-empty content' })
    vi.mocked(api.invoke).mockResolvedValueOnce(note)

    const { result, unmount } = renderHook(() => useNoteEditor('note-1'))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    unmount()

    // NOTES_DELETE should NOT have been called (only NOTES_GET was called)
    const deleteCalls = vi.mocked(api.invoke).mock.calls.filter(
      call => call[0] === IPC_CHANNELS.NOTES_DELETE
    )
    expect(deleteCalls).toHaveLength(0)
  })

  it('calls NOTES_DELETE on unmount when note is empty', async () => {
    const note = makeNote({ content: '', title: '' })
    vi.mocked(api.invoke)
      .mockResolvedValueOnce(note)   // NOTES_GET
      .mockResolvedValueOnce(true)   // NOTES_DELETE (cleanup)

    const { result, unmount } = renderHook(() => useNoteEditor('note-1'))
    await waitFor(() => expect(result.current.loadState).toBe('loaded'))

    unmount()

    await waitFor(() => {
      const deleteCalls = vi.mocked(api.invoke).mock.calls.filter(
        call => call[0] === IPC_CHANNELS.NOTES_DELETE
      )
      expect(deleteCalls.length).toBeGreaterThan(0)
    })
  })
})
