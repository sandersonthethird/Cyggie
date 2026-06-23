import { describe, it, expect, vi } from 'vitest'
import { resolveNoteSaveContent } from '../save-content'

// 3A/4A — the don't-touch-untouched guard is THE testable data-loss protection
// for the rich editor (the WebView round-trip itself can't run in jest).

describe('resolveNoteSaveContent', () => {
  it('flag OFF → saves draftContent verbatim (plain TextInput path)', async () => {
    const getMarkdown = vi.fn()
    const out = await resolveNoteSaveContent({
      richEnabled: false,
      dirty: true,
      draftContent: '# original',
      getMarkdown,
    })
    expect(out).toBe('# original')
    expect(getMarkdown).not.toHaveBeenCalled()
  })

  it('rich ON but NOT dirty → saves the ORIGINAL markdown verbatim (no round-trip)', async () => {
    const getMarkdown = vi.fn(async () => 'reserialized')
    const out = await resolveNoteSaveContent({
      richEnabled: true,
      dirty: false,
      draftContent: '# desktop-authored\n\n- a\n  - nested',
      getMarkdown,
    })
    expect(out).toBe('# desktop-authored\n\n- a\n  - nested')
    expect(getMarkdown).not.toHaveBeenCalled()
  })

  it('rich ON + dirty → extracts markdown from the editor', async () => {
    const out = await resolveNoteSaveContent({
      richEnabled: true,
      dirty: true,
      draftContent: 'stale',
      getMarkdown: async () => '**edited**',
    })
    expect(out).toBe('**edited**')
  })

  it('extract throws → falls back to draftContent (never loses the note)', async () => {
    const out = await resolveNoteSaveContent({
      richEnabled: true,
      dirty: true,
      draftContent: 'last known good',
      getMarkdown: async () => {
        throw new Error('webview gone')
      },
    })
    expect(out).toBe('last known good')
  })

  it('rich ON + dirty but no editor ref → verbatim', async () => {
    const out = await resolveNoteSaveContent({
      richEnabled: true,
      dirty: true,
      draftContent: 'verbatim',
      getMarkdown: null,
    })
    expect(out).toBe('verbatim')
  })
})
