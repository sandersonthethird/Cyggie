// @vitest-environment jsdom
/**
 * Draft-persistence tests for NoteCreator.
 *
 * Bug: the composer kept typed text only in the in-memory TipTap editor, so an
 * unsaved note was lost on app close / reload / nav. NoteCreator now persists
 * the in-progress draft to localStorage (via safe-storage) on each edit,
 * restores it on mount, and clears it on save/cancel.
 *
 *   What's verified (the new code paths):
 *     • persist-on-edit   → setJSON('cyggie:note-draft:<key>', md) on update
 *     • skip-empty        → clearing the editor does NOT leave a "" draft
 *     • restore-on-mount  → a stored draft is loaded + the actions row revealed
 *     • clear-on-save     → removeKey after a successful save
 *     • clear-on-cancel   → removeKey on cancel
 *     • key-switch (A→B)  → B's draft (or clear) loads; A's text never leaks
 *
 * Mock boundaries:
 *   - useTiptapMarkdown → a controllable fake editor + a loadContent spy that
 *     mutates the fake (so getMarkdown / isEmpty reflect a restored draft).
 *   - safe-storage      → a Map-backed store so getJSON/setJSON/removeKey round-trip.
 *   - TipTap view bits  → stubbed to nothing (we drive the editor directly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const store = new Map<string, string>()
  const ref: { editor: ReturnType<typeof buildFake> | null } = { editor: null }
  function buildFake() {
    const handlers: Record<string, Array<() => void>> = {}
    const fire = (evt: string) => (handlers[evt] ?? []).forEach((cb) => cb())
    const ed = {
      isEmpty: true,
      _md: '',
      on: (evt: string, cb: () => void) => {
        ;(handlers[evt] ??= []).push(cb)
      },
      off: (evt: string, cb: () => void) => {
        handlers[evt] = (handlers[evt] ?? []).filter((x) => x !== cb)
      },
      getMarkdown: () => ed._md,
      getText: () => ed._md,
      commands: {
        clearContent: () => {
          ed._md = ''
          ed.isEmpty = true
          fire('update')
        },
      },
      view: { dom: document.createElement('div') },
      // test helper: simulate the user typing
      type: (md: string) => {
        ed._md = md
        ed.isEmpty = md.trim() === ''
        fire('update')
      },
    }
    return ed
  }
  const loadContent = vi.fn((md: string) => {
    if (h.ref.editor) {
      h.ref.editor._md = md
      h.ref.editor.isEmpty = md.trim() === ''
    }
  })
  return { store, ref, buildFake, loadContent }
})

vi.mock('../renderer/hooks/useTiptapMarkdown', () => ({
  useTiptapMarkdown: () => ({ editor: h.ref.editor, loadContent: h.loadContent, isLoaded: false }),
}))
vi.mock('../renderer/lib/safe-storage', () => ({
  getJSON: vi.fn((k: string, d: unknown) =>
    h.store.has(k) ? JSON.parse(h.store.get(k)!) : d,
  ),
  setJSON: vi.fn((k: string, v: unknown) => {
    h.store.set(k, JSON.stringify(v))
  }),
  removeKey: vi.fn((k: string) => {
    h.store.delete(k)
  }),
}))
// View-layer + extension imports: stub so the real TipTap stack never loads.
vi.mock('../renderer/components/common/TiptapBubbleMenu', () => ({ TiptapBubbleMenu: () => null }))
vi.mock('@tiptap/react', () => ({ EditorContent: () => null }))
vi.mock('@tiptap/starter-kit', () => ({ default: {} }))
vi.mock('@tiptap/markdown', () => ({ Markdown: {} }))
vi.mock('@tiptap/extension-link', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('@tiptap/extension-image', () => ({ default: {} }))
vi.mock('@tiptap/extension-placeholder', () => ({ default: { configure: vi.fn(() => ({})) } }))
vi.mock('../renderer/lib/tiptap-extensions', () => ({ TABLE_EXTENSIONS: [] }))

const { NoteCreator } = await import('../renderer/components/common/NoteCreator')
const { setJSON, removeKey } = await import('../renderer/lib/safe-storage')

const KEY_A = 'cyggie:note-draft:company:a'
const KEY_B = 'cyggie:note-draft:company:b'

describe('NoteCreator — draft persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.store.clear()
    h.ref.editor = h.buildFake()
  })

  afterEach(() => {
    cleanup()
  })

  it('persists the draft to localStorage on each edit', () => {
    render(<NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:a" />)

    act(() => h.ref.editor!.type('hello world'))

    expect(setJSON).toHaveBeenCalledWith(KEY_A, 'hello world')
    expect(h.store.get(KEY_A)).toBe(JSON.stringify('hello world'))
  })

  it('does not persist an empty draft (clearing leaves no "" entry)', () => {
    render(<NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:a" />)

    act(() => h.ref.editor!.type('temp'))
    act(() => h.ref.editor!.commands.clearContent()) // fires update with isEmpty=true

    expect(h.store.has(KEY_A)).toBe(false)
  })

  it('restores a stored draft on mount and reveals the actions row', () => {
    h.store.set(KEY_A, JSON.stringify('saved draft'))

    const { getByText } = render(
      <NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:a" />,
    )

    expect(h.loadContent).toHaveBeenCalledWith('saved draft')
    // Actions row only renders when focused → restore set focused=true.
    expect(getByText('Save Note')).toBeTruthy()
  })

  it('clears the draft after a successful save', async () => {
    h.store.set(KEY_A, JSON.stringify('to save'))
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { getByText } = render(<NoteCreator onSave={onSave} draftKey="company:a" />)

    await act(async () => {
      fireEvent.click(getByText('Save Note'))
    })

    expect(onSave).toHaveBeenCalledWith('to save')
    expect(removeKey).toHaveBeenCalledWith(KEY_A)
    expect(h.store.has(KEY_A)).toBe(false)
  })

  it('clears the draft on cancel', () => {
    h.store.set(KEY_A, JSON.stringify('to discard'))
    const { getByText } = render(
      <NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:a" />,
    )

    act(() => {
      fireEvent.click(getByText('Cancel'))
    })

    expect(removeKey).toHaveBeenCalledWith(KEY_A)
    expect(h.store.has(KEY_A)).toBe(false)
  })

  it('on entity switch (A→B) loads B and does not leak A’s text', () => {
    h.store.set(KEY_A, JSON.stringify('draft A'))
    // B has no draft.
    const { rerender } = render(
      <NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:a" />,
    )
    expect(h.loadContent).toHaveBeenCalledWith('draft A')

    h.loadContent.mockClear()
    rerender(<NoteCreator onSave={vi.fn().mockResolvedValue(undefined)} draftKey="company:b" />)

    // B has no stored draft → editor cleared, A's text never loaded into B.
    expect(h.loadContent).not.toHaveBeenCalled()
    expect(h.ref.editor!._md).toBe('')
    expect(h.store.has(KEY_B)).toBe(false)
  })
})
