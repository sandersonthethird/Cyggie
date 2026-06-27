// =============================================================================
// attachment-upload-extension.ts — in-flight image upload preview as a
// ProseMirror DECORATION (not a document node).
//
// WHY A DECORATION (eng-review decision 2A): the instant preview must show the
// moment a user pastes/drops, but the `cyggie-attachment://{id}` reference must
// NOT enter saved/synced markdown until the R2 PUT + metadata row succeed
// (else other devices see a broken ref). A real Image node would be serialized
// by the 800ms autosave immediately. A widget decoration is NOT part of the
// document — so `getMarkdown()` can never serialize an unconfirmed preview. On
// success we swap it for a real Image node; on failure we just drop it.
//
//   addUploadPreview(id, previewUrl)      → widget decoration at the cursor
//   resolveUploadPreview(id, src, alt)    → real Image node at the preview pos,
//                                           decoration removed
//   removeUploadPreview(id)               → decoration removed (failure path)
//
// Decorations auto-map through transactions, so the preview tracks the cursor
// as the user keeps typing during the upload.
// =============================================================================

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const key = new PluginKey<DecorationSet>('attachmentUploadPreview')

type PreviewMeta =
  | { type: 'add'; id: string; pos: number; previewUrl?: string; label?: string }
  | { type: 'remove'; id: string }

// Image previews show the blob thumbnail; non-image (PDF) previews show a small
// labeled pill (a blob: PDF can't render in an <img>). Both carry the spinner.
function buildPreviewDom(opts: { previewUrl?: string; label?: string }): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'attachmentUploadPreview'
  wrap.setAttribute('contenteditable', 'false')
  if (opts.previewUrl) {
    const img = document.createElement('img')
    img.src = opts.previewUrl
    img.className = 'attachmentUploadPreviewImg'
    wrap.appendChild(img)
  } else {
    const label = document.createElement('span')
    label.className = 'attachmentUploadPreviewLabel'
    label.textContent = opts.label ?? 'Uploading…'
    wrap.appendChild(label)
  }
  const spinner = document.createElement('span')
  spinner.className = 'attachmentUploadSpinner'
  wrap.appendChild(spinner)
  return wrap
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    attachmentUpload: {
      addUploadPreview: (args: { id: string; previewUrl?: string; label?: string }) => ReturnType
      resolveUploadPreview: (args: { id: string; src: string; alt?: string }) => ReturnType
      resolvePdfPreview: (args: { id: string; attachmentId: string; name?: string }) => ReturnType
      removeUploadPreview: (args: { id: string }) => ReturnType
    }
  }
}

export const AttachmentUpload = Extension.create({
  name: 'attachmentUpload',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            // Map existing decorations through the document change first.
            let next = set.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(key) as PreviewMeta | undefined
            if (meta?.type === 'add') {
              const widget = Decoration.widget(
                meta.pos,
                () => buildPreviewDom({ previewUrl: meta.previewUrl, label: meta.label }),
                { id: meta.id, side: 1 },
              )
              next = next.add(tr.doc, [widget])
            } else if (meta?.type === 'remove') {
              const found = next.find(undefined, undefined, (spec) => spec['id'] === meta.id)
              if (found.length) next = next.remove(found)
            }
            return next
          },
        },
        props: {
          decorations(state) {
            return key.getState(state) ?? DecorationSet.empty
          },
        },
      }),
    ]
  },

  addCommands() {
    return {
      addUploadPreview:
        ({ id, previewUrl, label }) =>
        ({ state, dispatch }) => {
          if (dispatch) {
            const pos = state.selection.from
            dispatch(state.tr.setMeta(key, { type: 'add', id, pos, previewUrl, label }))
          }
          return true
        },

      removeUploadPreview:
        ({ id }) =>
        ({ state, dispatch }) => {
          if (dispatch) dispatch(state.tr.setMeta(key, { type: 'remove', id }))
          return true
        },

      resolveUploadPreview:
        ({ id, src, alt }) =>
        ({ state, chain }) => {
          const set = key.getState(state)
          const found = set?.find(undefined, undefined, (spec) => spec['id'] === id) ?? []
          const pos = found.length ? found[0].from : state.selection.from
          // Use the Image extension's setImage so block/inline insertion is
          // handled by its schema; then drop the decoration in the same chain.
          return chain()
            .setTextSelection(pos)
            .setImage({ src, alt: alt ?? undefined })
            .command(({ tr, dispatch }) => {
              if (dispatch) dispatch(tr.setMeta(key, { type: 'remove', id }))
              return true
            })
            .run()
        },

      resolvePdfPreview:
        ({ id, attachmentId, name }) =>
        ({ state, chain }) => {
          const set = key.getState(state)
          const found = set?.find(undefined, undefined, (spec) => spec['id'] === id) ?? []
          const pos = found.length ? found[0].from : state.selection.from
          // Swap the in-flight preview for the real PdfAttachment node (its own
          // setPdfAttachment handles block insertion), then drop the decoration.
          return chain()
            .setTextSelection(pos)
            .setPdfAttachment({ attachmentId, name })
            .command(({ tr, dispatch }) => {
              if (dispatch) dispatch(tr.setMeta(key, { type: 'remove', id }))
              return true
            })
            .run()
        },
    }
  },
})
