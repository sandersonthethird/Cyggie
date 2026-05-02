/**
 * FindHighlight — render find-in-page matches as <mark> decorations.
 *
 * INPUT CONTRACT (do NOT break):
 *   matches[] are character offsets into editor.state.doc.textContent.
 *   ProseMirror's Node.textContent concatenates text nodes WITHOUT separators.
 *   editor.getText() inserts \n\n between blocks by default — DIFFERENT semantics.
 *
 *   Caller MUST pass textContent (not getText()) to useFindInPage so positions
 *   align with the cursor walk in decorations() below.
 *
 *   text-coord 0 ─────────── editor.state.doc.textContent ─────────── N
 *                                  │
 *                                  ▼
 *           descendants((node, pos) => cursor += node.text.length)
 *                                  │
 *                                  ▼
 *                             PM doc-coord  → Decoration.inline(from, to, ...)
 *
 *   match start/end ──────────── from = pos + (m.start - cursor)
 *                                to   = pos + (m.end   - cursor)
 *
 * Decorations render as <mark> (and <mark class="markActive"> for the active
 * one) so the existing globals.css `mark` / `mark.markActive` rules apply
 * unchanged, and FindBar's `document.querySelector('mark.markActive')?.scrollIntoView()`
 * keeps working.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface FindMatch {
  start: number
  end: number
}

interface FindState {
  matches: FindMatch[]
  activeIndex: number
}

const findKey = new PluginKey<FindState>('findHighlight')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    findHighlight: {
      setFindMatches: (matches: FindMatch[], activeIndex: number) => ReturnType
      clearFindMatches: () => ReturnType
    }
  }
}

export const FindHighlight = Extension.create({
  name: 'findHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ matches: [], activeIndex: -1 }),
          apply(tr, value) {
            const meta = tr.getMeta(findKey) as FindState | undefined
            return meta ?? value
          },
        },
        props: {
          decorations(state) {
            const v = findKey.getState(state)
            if (!v || v.matches.length === 0) return DecorationSet.empty

            // Sort matches by start so we can walk linearly. Track which match we're
            // looking for via mi; advance only when fully consumed.
            const matches = [...v.matches].sort((a, b) => a.start - b.start)
            const decos: Decoration[] = []
            let cursor = 0
            let mi = 0

            state.doc.descendants((node, pos) => {
              if (mi >= matches.length) return false
              if (!node.isText) return true
              const text = node.text ?? ''
              const len = text.length
              const nodeEnd = cursor + len

              while (mi < matches.length && matches[mi].start < nodeEnd) {
                const m = matches[mi]
                const fromOffset = Math.max(0, m.start - cursor)
                const toOffset = Math.min(len, m.end - cursor)
                if (toOffset > fromOffset) {
                  decos.push(
                    Decoration.inline(pos + fromOffset, pos + toOffset, {
                      nodeName: 'mark',
                      ...(mi === v.activeIndex ? { class: 'markActive' } : {}),
                    })
                  )
                }
                if (m.end <= nodeEnd) {
                  mi += 1
                } else {
                  // Match continues into the next text node; stop here, the next
                  // iteration of descendants will pick it up.
                  break
                }
              }
              cursor = nodeEnd
              return false
            })

            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },

  addCommands() {
    return {
      setFindMatches:
        (matches, activeIndex) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findKey, { matches, activeIndex }))
          return true
        },
      clearFindMatches:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findKey, { matches: [], activeIndex: -1 }))
          return true
        },
    }
  },
})
