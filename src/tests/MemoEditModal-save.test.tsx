// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { InvestmentMemoWithLatest, InvestmentMemoVersion } from '../shared/types/company'

// Stub CSS imports.
vi.mock('../renderer/components/company/MemoEditModal.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock('../renderer/components/common/ConfirmDialog.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

// Stub the IPC API surface. The renderer's `api.invoke` is the only side-effect
// path we care about — we track its calls to assert "no save on mount" etc.
const invokeMock = vi.fn(async () => fakeVersion())
vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) },
}))

// useTiptapMarkdown is mocked to avoid pulling in the real Tiptap editor
// (which requires more DOM than jsdom provides). We expose `loadContent` +
// `editor: null` shape and a way to drive the onUpdate callback by hand.
let captured: { onUpdate?: (arg: { editor: unknown }) => void } = {}
vi.mock('../renderer/hooks/useTiptapMarkdown', () => ({
  useTiptapMarkdown: (opts: { onUpdate?: (arg: { editor: unknown }) => void }) => {
    captured = opts
    return { editor: null, loadContent: () => {}, isLoaded: true }
  },
}))

// FindBar + TiptapBubbleMenu are render-only; stub them to no-ops.
vi.mock('../renderer/components/common/FindBar', () => ({
  default: () => null,
}))
vi.mock('../renderer/components/common/TiptapBubbleMenu', () => ({
  TiptapBubbleMenu: () => null,
}))
// EditorContent renders nothing in the absence of a real editor.
vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
}))

const { MemoEditModal } = await import('../renderer/components/company/MemoEditModal')

function fakeVersion(): InvestmentMemoVersion {
  return {
    id: 'v-new',
    memoId: 'memo-1',
    versionNumber: 2,
    contentMarkdown: '# Saved',
    changeNote: null,
    createdAt: new Date().toISOString(),
    createdBy: 'u-1',
  } as InvestmentMemoVersion
}

function makeMemo(): InvestmentMemoWithLatest {
  return {
    id: 'memo-1',
    title: 'Test Memo',
    status: 'draft',
    latestVersionNumber: 1,
    latestVersion: {
      id: 'v-1',
      memoId: 'memo-1',
      versionNumber: 1,
      contentMarkdown: '# Hello',
      changeNote: 'Initial',
      createdAt: new Date().toISOString(),
      createdBy: 'u-1',
    },
    companyId: 'c-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as InvestmentMemoWithLatest
}

/**
 * Helper: simulate the user typing in the editor, which is the only path that
 * should make the memo dirty under the new explicit-save model.
 */
function userTypes(newMarkdown: string) {
  // setContentDraft fires inside onUpdate — wrap in act() so React flushes
  // the state update before the next assertion runs.
  act(() => {
    captured.onUpdate?.({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor: { getMarkdown: () => newMarkdown } as any,
    })
  })
}

beforeEach(() => {
  invokeMock.mockClear()
  invokeMock.mockResolvedValue(fakeVersion())
  captured = {}
})
afterEach(() => cleanup())

describe('MemoEditModal — explicit-save model', () => {
  it('does NOT save on mount (no autosave; the v3-v15 bug fix)', async () => {
    render(<MemoEditModal memo={makeMemo()} onSaved={vi.fn()} onClose={vi.fn()} />)
    // Let any debounced/queued effects flush.
    await new Promise((r) => setTimeout(r, 100))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does NOT save on typing (debounced autosave removed)', async () => {
    render(<MemoEditModal memo={makeMemo()} onSaved={vi.fn()} onClose={vi.fn()} />)
    userTypes('# Hello world')
    // Wait far longer than the previous 800ms debounce.
    await new Promise((r) => setTimeout(r, 1200))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('saves once when ⌘S is pressed and content is dirty', async () => {
    const onSaved = vi.fn()
    render(<MemoEditModal memo={makeMemo()} onSaved={onSaved} onClose={vi.fn()} />)
    userTypes('# Hello world')
    fireEvent.keyDown(document, { key: 's', metaKey: true })
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it('⌘S does nothing when content is not dirty', async () => {
    render(<MemoEditModal memo={makeMemo()} onSaved={vi.fn()} onClose={vi.fn()} />)
    fireEvent.keyDown(document, { key: 's', metaKey: true })
    await new Promise((r) => setTimeout(r, 100))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('saves on Save button click when dirty', async () => {
    const onSaved = vi.fn()
    const { getByText } = render(
      <MemoEditModal memo={makeMemo()} onSaved={onSaved} onClose={vi.fn()} />,
    )
    userTypes('# Hello world')
    fireEvent.click(getByText('Save'))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
  })

  it('closes immediately when clean (no confirm dialog)', async () => {
    const onClose = vi.fn()
    const { getByText, queryByText } = render(
      <MemoEditModal memo={makeMemo()} onSaved={vi.fn()} onClose={onClose} />,
    )
    fireEvent.click(getByText('Done'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    // Discard dialog never shown.
    expect(queryByText('Unsaved changes')).toBeNull()
  })

  it('shows discard dialog when closing with dirty content', async () => {
    const onClose = vi.fn()
    const { getByText } = render(
      <MemoEditModal memo={makeMemo()} onSaved={vi.fn()} onClose={onClose} />,
    )
    userTypes('# Hello world')
    fireEvent.click(getByText('Done'))
    // Dialog appears with the three buttons.
    await waitFor(() => {
      expect(getByText('Discard')).toBeTruthy()
      expect(getByText('Keep editing')).toBeTruthy()
    })
    // Did NOT call onClose yet.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Discard button closes without saving', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const { getByText } = render(
      <MemoEditModal memo={makeMemo()} onSaved={onSaved} onClose={onClose} />,
    )
    userTypes('# Hello world')
    fireEvent.click(getByText('Done'))
    await waitFor(() => getByText('Discard'))
    fireEvent.click(getByText('Discard'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(invokeMock).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('Save button inside discard dialog saves then closes', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const { getByText, getAllByText } = render(
      <MemoEditModal memo={makeMemo()} onSaved={onSaved} onClose={onClose} />,
    )
    userTypes('# Hello world')
    fireEvent.click(getByText('Done'))
    await waitFor(() => getByText('Discard'))
    // Click the Save button inside the dialog (the confirmButton). There may
    // be two "Save" buttons on the page (header + dialog); click the last one
    // (the dialog's primary button is rendered after the header's).
    const saves = getAllByText('Save')
    fireEvent.click(saves[saves.length - 1])
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
