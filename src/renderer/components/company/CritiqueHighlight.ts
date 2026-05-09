/**
 * CritiqueHighlight — TipTap extension that renders a faint red wavy
 * underline on memo claims that have an active critique evidence row.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Input: an array of claim_text strings (already substringed     │
 *   │  from memo_evidence rows where is_critique=1). The extension    │
 *   │  walks the doc, finds each substring (first occurrence), and    │
 *   │  emits an inline Decoration with class "critique-highlight".    │
 *   │                                                                 │
 *   │  Hover/click integration: the parent component listens at the   │
 *   │  document level for clicks on `.critique-highlight` and opens   │
 *   │  the EvidenceSidebar focused on that claim.                     │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Patterns mirrored from FindHighlight: positions are computed against
 * editor.state.doc.textContent (text nodes concatenated, no \n inserts) so
 * substring matching aligns with PM doc coordinates via the standard
 * descendants() walk.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

interface State {
  claimTexts: string[]
}

const key = new PluginKey<State>('critiqueHighlight')

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    critiqueHighlight: {
      setCritiqueClaims: (claimTexts: string[]) => ReturnType
      clearCritiqueClaims: () => ReturnType
    }
  }
}

export const CritiqueHighlight = Extension.create({
  name: 'critiqueHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<State>({
        key,
        state: {
          init: (): State => ({ claimTexts: [] }),
          apply(tr, prev) {
            const meta = tr.getMeta(key) as Partial<State> | undefined
            if (!meta) return prev
            return { claimTexts: meta.claimTexts ?? [] }
          },
        },
        props: {
          decorations(state) {
            const pluginState = key.getState(state)
            if (!pluginState || pluginState.claimTexts.length === 0) {
              return DecorationSet.empty
            }
            const text = state.doc.textContent
            const ranges: Array<{ start: number; end: number }> = []
            for (const claimText of pluginState.claimTexts) {
              if (!claimText.trim()) continue
              // First occurrence per claim. If the same claim shows up twice
              // (rare), only the first instance is highlighted — sufficient for
              // hover lookup.
              const idx = text.indexOf(claimText.trim())
              if (idx >= 0) ranges.push({ start: idx, end: idx + claimText.trim().length })
            }
            if (ranges.length === 0) return DecorationSet.empty

            const decos: Decoration[] = []
            // Walk doc and convert text-content offsets to PM doc offsets.
            let cursor = 0
            state.doc.descendants((node, pos) => {
              if (!node.isText) return
              const nodeStart = cursor
              const nodeEnd = cursor + (node.text?.length ?? 0)
              for (const range of ranges) {
                if (range.end <= nodeStart || range.start >= nodeEnd) continue
                const overlapStart = Math.max(range.start, nodeStart)
                const overlapEnd = Math.min(range.end, nodeEnd)
                const fromDoc = pos + (overlapStart - nodeStart)
                const toDoc = pos + (overlapEnd - nodeStart)
                decos.push(Decoration.inline(fromDoc, toDoc, { class: 'critique-highlight' }))
              }
              cursor = nodeEnd
            })
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },

  addCommands() {
    return {
      setCritiqueClaims:
        (claimTexts: string[]) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(key, { claimTexts }))
          return true
        },
      clearCritiqueClaims:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(key, { claimTexts: [] }))
          return true
        },
    }
  },
})
