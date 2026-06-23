import { forwardRef, useImperativeHandle, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { RichText, Toolbar, useEditorBridge } from '@10play/tentap-editor'
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'

import { colors } from '../theme'

// =============================================================================
// RichNoteEditor — Tiptap-in-WebView note editor (M5 PR3), behind a flag with a
// TextInput fallback (see notes/[id].tsx). Notes are MARKDOWN-canonical (desktop
// round-trips via @tiptap/markdown), but tentap works in HTML — so we shim:
//
//   load:  draftContent (md) ──markdown-it──▶ HTML ──▶ tentap initialContent
//   save:  tentap getHTML() ──turndown──▶ md ──▶ updateNote(content)
//
// The parent owns a DIRTY flag (set via onChange) and only calls getMarkdown()
// when the note was actually edited — an un-touched note is saved VERBATIM (its
// original markdown), so opening a desktop-authored note on mobile can never
// re-serialize/corrupt it (review decision 4A).
//
// ⚠️ VERIFY ON A DEV BUILD: the exact @10play/tentap-editor API (useEditorBridge
// shape, getHTML(), the change-subscription) and the md↔html fidelity for the
// supported subset (bold/italic/headings/lists/links/code). Unsupported
// constructs (tables, deep nesting) should round-trip as text, not be dropped.
// This component is default-OFF and wrapped in an ErrorBoundary, so a wrong
// guess here degrades to the plain TextInput rather than breaking note editing.
// =============================================================================

export interface RichNoteEditorHandle {
  /** Extract the current editor content as markdown (called on save when dirty). */
  getMarkdown: () => Promise<string>
}

interface RichNoteEditorProps {
  /** Initial note body, as markdown. */
  initialMarkdown: string
  /** Fired when the user edits — the parent flips its dirty flag. */
  onChange: () => void
  editable?: boolean
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

export const RichNoteEditor = forwardRef<RichNoteEditorHandle, RichNoteEditorProps>(
  function RichNoteEditor({ initialMarkdown, onChange, editable = true }, ref) {
    const initialHTML = useMemo(() => md.render(initialMarkdown ?? ''), [initialMarkdown])

    const editor = useEditorBridge({
      autofocus: false,
      avoidIosKeyboard: true,
      editable,
      initialContent: initialHTML,
      // Fire the parent's dirty signal on any content update.
      onChange,
    })

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: async () => {
          const html = await editor.getHTML()
          return turndown.turndown(html ?? '')
        },
      }),
      [editor],
    )

    return (
      <View style={styles.root}>
        <RichText editor={editor} />
        {editable && (
          <View style={styles.toolbar}>
            <Toolbar editor={editor} />
          </View>
        )}
      </View>
    )
  },
)

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 240, backgroundColor: colors.surface },
  toolbar: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
})
