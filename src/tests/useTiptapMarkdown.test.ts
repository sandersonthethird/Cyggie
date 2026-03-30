// @vitest-environment jsdom
/**
 * Tests for useTiptapMarkdown hook.
 *
 * What we're verifying:
 *   The core behavioral contract of Approach E — the hook passes content: null
 *   to useEditor, then calls setContent(markdown, { contentType: 'markdown' })
 *   in a useEffect after the editor is fully initialized. This guarantees
 *   @tiptap/markdown's setContent override runs with this.editor.markdown set.
 *
 * Mock boundaries:
 *   - @tiptap/react → captures useEditor call options; returns a new editor
 *     instance when deps change (simulating real useEditor's recreate-on-deps
 *     behavior) so the useEffect([editor]) dependency correctly re-fires.
 *   - Extensions → minimal stubs (we're testing the hook, not ProseMirror)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// --- Mocks (set up before importing the hook) ---

// Shared setContent spy — outlives individual editor instances so we can
// assert calls across recreations without needing a reference to the latest editor.
const setContentSpy = vi.fn()

function makeMockEditor() {
  return {
    setEditable: vi.fn(),
    storage: {},
    commands: { setContent: setContentSpy },
  }
}

// Simulate useEditor's "recreate when deps change" behavior:
// same deps → same editor instance; changed deps → new editor instance.
// Only calls onCreate when the editor is genuinely new (matching real lifecycle).
const editorMap = new Map<string, ReturnType<typeof makeMockEditor>>()

const useEditorMock = vi.fn((options: Record<string, unknown>, deps?: unknown[]) => {
  const key = JSON.stringify(deps ?? [])
  const isNew = !editorMap.has(key)
  if (isNew) editorMap.set(key, makeMockEditor())
  const editor = editorMap.get(key)!
  if (isNew) options?.onCreate?.({ editor })
  return editor
})

vi.mock('@tiptap/react', () => ({ useEditor: useEditorMock }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: { configure: vi.fn(() => ({})) } }))

// --- Import after mocks ---

const { useTiptapMarkdown } = await import('../renderer/hooks/useTiptapMarkdown')

// --- Tests ---

describe('useTiptapMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    editorMap.clear()
    setContentSpy.mockReset()
  })

  it('passes content: null to useEditor (content is loaded via setContent useEffect, not options)', () => {
    renderHook(() => useTiptapMarkdown({ extensions: [] }))
    const options = useEditorMock.mock.calls[0][0] as Record<string, unknown>
    expect(options.content).toBeNull()
  })

  it('does not pass contentType to useEditor options (markdown parsing is via setContent command)', () => {
    renderHook(() => useTiptapMarkdown({ extensions: [] }))
    const options = useEditorMock.mock.calls[0][0] as Record<string, unknown>
    expect(options.contentType).toBeUndefined()
  })

  it('does not call setContent before loadContent is called (safe empty state, no crash)', () => {
    renderHook(() => useTiptapMarkdown({ extensions: [] }))
    expect(setContentSpy).not.toHaveBeenCalled()
  })

  it('calls setContent with { contentType: "markdown" } after loadContent is called', async () => {
    const { result } = renderHook(() => useTiptapMarkdown({ extensions: [] }))
    act(() => result.current.loadContent('**bold** text'))
    await waitFor(() => {
      expect(setContentSpy).toHaveBeenCalledWith(
        '**bold** text',
        expect.objectContaining({ contentType: 'markdown' }),
      )
    })
  })

  it('isLoaded starts false and becomes true after loadContent', () => {
    const { result } = renderHook(() => useTiptapMarkdown({ extensions: [] }))
    expect(result.current.isLoaded).toBe(false)
    act(() => result.current.loadContent('# Hello'))
    expect(result.current.isLoaded).toBe(true)
  })

  it('loadContent is stable across renders (same reference)', () => {
    const { result, rerender } = renderHook(() => useTiptapMarkdown({ extensions: [] }))
    const first = result.current.loadContent
    rerender()
    expect(result.current.loadContent).toBe(first)
  })
})
