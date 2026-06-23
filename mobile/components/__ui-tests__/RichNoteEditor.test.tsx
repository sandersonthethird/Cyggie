import { createRef } from 'react'
import { render, screen } from '@testing-library/react-native'

// tentap is a WebView editor — un-runnable in jest. Mock the bridge so we can
// test RichNoteEditor's contract: it renders the editor + toolbar, and
// getMarkdown() extracts the editor HTML and converts it back to markdown
// (real turndown runs — it's pure JS). jest.mock factories may only reference
// out-of-scope vars prefixed with `mock`.
const mockGetHTML = jest.fn(async () => '<h2>Title</h2><p><strong>bold</strong> and <em>italic</em></p>')
jest.mock('@10play/tentap-editor', () => {
  const React = require('react')
  const { View } = require('react-native')
  return {
    useEditorBridge: () => ({ getHTML: mockGetHTML }),
    RichText: () => React.createElement(View, { accessibilityLabel: 'rich-text' }),
    Toolbar: () => React.createElement(View, { accessibilityLabel: 'toolbar' }),
  }
})

import { RichNoteEditor, type RichNoteEditorHandle } from '../RichNoteEditor'

describe('RichNoteEditor', () => {
  test('renders the editor + toolbar when editable', () => {
    render(<RichNoteEditor initialMarkdown="# hi" onChange={() => {}} editable />)
    expect(screen.getByLabelText('rich-text')).toBeOnTheScreen()
    expect(screen.getByLabelText('toolbar')).toBeOnTheScreen()
  })

  test('hides the toolbar when not editable', () => {
    render(<RichNoteEditor initialMarkdown="# hi" onChange={() => {}} editable={false} />)
    expect(screen.queryByLabelText('toolbar')).toBeNull()
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
