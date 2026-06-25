// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
import { validateImageFile } from '../attachment-insert'
import { AttachmentUpload } from '../attachment-upload-extension'
import { ATTACHMENT_MAX_UPLOAD_BYTES } from '../../../shared/attachments'

describe('validateImageFile', () => {
  it('accepts a raster image by mime', () => {
    expect(validateImageFile({ name: 'shot.png', type: 'image/png', size: 1024 })).toEqual({
      ok: true,
      mime: 'image/png',
    })
  })

  it('accepts by extension when mime is missing (some drops)', () => {
    const v = validateImageFile({ name: 'photo.JPG', type: '', size: 1024 })
    expect(v).toEqual({ ok: true, mime: 'image/jpeg' })
  })

  it('rejects SVG (no inline active content — decision 3A)', () => {
    const v = validateImageFile({ name: 'logo.svg', type: 'image/svg+xml', size: 100 })
    expect(v.ok).toBe(false)
  })

  it('rejects a non-image', () => {
    expect(validateImageFile({ name: 'notes.txt', type: 'text/plain', size: 10 }).ok).toBe(false)
  })

  it('rejects an empty file', () => {
    expect(validateImageFile({ name: 'x.png', type: 'image/png', size: 0 }).ok).toBe(false)
  })

  it('rejects an oversize file', () => {
    const v = validateImageFile({ name: 'big.png', type: 'image/png', size: ATTACHMENT_MAX_UPLOAD_BYTES + 1 })
    expect(v.ok).toBe(false)
  })
})

function makeEditor(): Editor {
  return new Editor({ extensions: [StarterKit, Markdown, Image, AttachmentUpload], content: '<p>hello</p>' })
}
function getMarkdown(editor: Editor): string {
  return (editor as unknown as { getMarkdown?: () => string }).getMarkdown?.() ?? editor.getText()
}

describe('AttachmentUpload decoration — never serializes (invariant 2A)', () => {
  it('an in-flight preview does NOT appear in getMarkdown()', () => {
    const editor = makeEditor()
    const before = getMarkdown(editor)
    editor.commands.addUploadPreview({ id: 'p1', previewUrl: 'blob:fake-preview-url' })
    const during = getMarkdown(editor)
    // The decoration is not part of the document, so the serialized markdown is
    // unchanged — no blob URL, no preview node leaks into saved/synced content.
    expect(during).toBe(before)
    expect(during).not.toContain('blob:')
    expect(during).not.toContain('p1')
    editor.destroy()
  })

  it('resolving a preview inserts a real Image node referencing cyggie-attachment://', () => {
    const editor = makeEditor()
    editor.commands.addUploadPreview({ id: 'p2', previewUrl: 'blob:fake' })
    editor.commands.resolveUploadPreview({ id: 'p2', src: 'cyggie-attachment://abc123', alt: 'shot.png' })
    const md = getMarkdown(editor)
    expect(md).toContain('cyggie-attachment://abc123')
    expect(md).not.toContain('blob:')
    editor.destroy()
  })

  it('removing a preview leaves the document untouched', () => {
    const editor = makeEditor()
    const before = getMarkdown(editor)
    editor.commands.addUploadPreview({ id: 'p3', previewUrl: 'blob:fake' })
    editor.commands.removeUploadPreview({ id: 'p3' })
    expect(getMarkdown(editor)).toBe(before)
    editor.destroy()
  })
})
