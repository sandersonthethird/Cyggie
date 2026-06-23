import { createRef } from 'react'
import { render, screen } from '@testing-library/react-native'

// tentap is a WebView editor — un-runnable in jest. Mock the bridge so we can
// test RichNoteEditor's contract: it renders the editor, hands its bridge up via
// onEditorReady (and clears it on unmount — the safety that hides the screen-root
// toolbar on a 409 remount / ErrorBoundary fallback), and getMarkdown() extracts
// the editor HTML and converts it back to markdown (real turndown runs — pure JS).
// jest.mock factories may only reference out-of-scope vars prefixed with `mock`.
const mockGetHTML = jest.fn(async () => '<h2>Title</h2><p><strong>bold</strong> and <em>italic</em></p>')
// Stable bridge identity so the onEditorReady effect doesn't refire across renders.
const mockEditor = { getHTML: mockGetHTML }
jest.mock('@10play/tentap-editor', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    useEditorBridge: () => mockEditor,
    RichText: () => React.createElement(View, { accessibilityLabel: 'rich-text' }),
    // Present so the mock is faithful, but RichNoteEditor no longer renders it.
    Toolbar: () => React.createElement(View, { accessibilityLabel: 'toolbar' }),
  }
})

import { RichNoteEditor, type RichNoteEditorHandle } from '../RichNoteEditor'

describe('RichNoteEditor', () => {
  test('renders the rich-text editor; the toolbar lives at the screen root, not here', () => {
    render(<RichNoteEditor initialMarkdown="# hi" onChange={() => {}} editable />)
    expect(screen.getByLabelText('rich-text')).toBeOnTheScreen()
    // The Toolbar is rendered by notes/[id].tsx at the screen root, NOT by this component.
    expect(screen.queryByLabelText('toolbar')).toBeNull()
  })

  test('hands the editor bridge up on mount and clears it (null) on unmount', () => {
    const onEditorReady = jest.fn()
    const { unmount } = render(
      <RichNoteEditor initialMarkdown="# hi" onChange={() => {}} onEditorReady={onEditorReady} />,
    )
    expect(onEditorReady).toHaveBeenCalledWith(mockEditor)
    onEditorReady.mockClear()
    unmount()
    // null-on-unmount is what hides the orphaned screen-root toolbar after a
    // 409 keyed remount or an ErrorBoundary→TextInput crash fallback.
    expect(onEditorReady).toHaveBeenCalledWith(null)
  })

  test('getMarkdown() extracts editor HTML and converts back to markdown', async () => {
    const ref = createRef<RichNoteEditorHandle>()
    render(<RichNoteEditor ref={ref} initialMarkdown="seed" onChange={() => {}} />)
    const md = await ref.current!.getMarkdown()
    expect(mockGetHTML).toHaveBeenCalled()
    // turndown(real) on the mocked HTML → markdown.
    expect(md).toContain('## Title')
    expect(md).toContain('**bold**')
    expect(md).toContain('_italic_')
  })
})
