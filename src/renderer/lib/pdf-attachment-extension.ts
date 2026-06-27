// =============================================================================
// pdf-attachment-extension.ts — inline PDF attachment node (M5, PR-PDF).
//
// Renders a dropped PDF inline via Chromium's built-in viewer (pdfium) in an
// <iframe src="cyggie-attachment://{id}">. Mirrors the Image attachment, but a
// PDF has no native markdown form, so it round-trips through an explicit,
// node-owned HTML marker:
//
//   markdown  <div data-attachment="{id}" data-kind="pdf" data-name="{name}"></div>
//        │  save: renderMarkdown() emits the div
//        │  load: marked passes the block HTML through → parseHTML claims the div
//        ▼
//   PdfAttachment node ──NodeView──▶ filename header + sandbox-isolated iframe
//
// SECURITY: the iframe is NOT no-script sandboxed — Chromium's PDF viewer needs
// scripts to render its UI, so `sandbox=""` would blank it. Isolation instead
// comes from (a) `cyggie-attachment://` being a DISTINCT origin (cross-origin
// from the app's 'self' — a PDF's own JS can't reach app state), (b) CSP
// `frame-ancestors 'none'` (the app can't be framed), and (c) serving only the
// user's own dropped bytes. We add `referrerpolicy=no-referrer` for good measure.
// =============================================================================

import { Node, mergeAttributes } from '@tiptap/core'

export interface PdfAttachmentOptions {
  /** Rendered height of the inline viewer (px). */
  height: number
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pdfAttachment: {
      setPdfAttachment: (attrs: { attachmentId: string; name?: string }) => ReturnType
    }
  }
}

/** Escape a string for safe inclusion in an HTML double-quoted attribute. */
function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export const PdfAttachment = Node.create<PdfAttachmentOptions>({
  name: 'pdfAttachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { height: 460 }
  },

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-attachment'),
        renderHTML: (attrs) => ({ 'data-attachment': attrs['attachmentId'] }),
      },
      name: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-name') ?? '',
        renderHTML: (attrs) => ({ 'data-name': attrs['name'] }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-attachment][data-kind="pdf"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-kind': 'pdf' })]
  },

  // @tiptap/markdown save hook: emit the explicit HTML marker (its own line so
  // marked treats it as a block-HTML token on the next load → parseHTML).
  renderMarkdown(node: { attrs: { attachmentId?: string; name?: string } }): string {
    const id = node.attrs.attachmentId ?? ''
    const name = node.attrs.name ?? ''
    return `<div data-attachment="${escAttr(id)}" data-kind="pdf" data-name="${escAttr(name)}"></div>\n`
  },

  addCommands() {
    return {
      setPdfAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { attachmentId: attrs.attachmentId, name: attrs.name ?? '' },
          }),
    }
  },

  addNodeView() {
    return ({ node }) => {
      const id = String(node.attrs['attachmentId'] ?? '')
      const name = String(node.attrs['name'] ?? '')

      const dom = document.createElement('div')
      dom.className = 'pdfAttachment'
      dom.setAttribute('data-attachment', id)
      dom.setAttribute('data-kind', 'pdf')
      dom.setAttribute('data-name', name)
      dom.contentEditable = 'false'

      const header = document.createElement('div')
      header.className = 'pdfAttachmentHeader'
      header.textContent = name || 'PDF'
      dom.appendChild(header)

      const frame = document.createElement('iframe')
      frame.className = 'pdfAttachmentFrame'
      frame.style.height = `${this.options.height}px`
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('title', name || 'PDF attachment')
      // Loadable only when the id is a real attachment (avoids a 400 on empty).
      if (id) frame.src = `cyggie-attachment://${id}#toolbar=0&navpanes=0`
      dom.appendChild(frame)

      return { dom }
    }
  },
})
