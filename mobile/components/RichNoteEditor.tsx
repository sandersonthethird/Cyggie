import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { RichText, useEditorBridge, type EditorBridge } from '@10play/tentap-editor'
// Pure-JS markdown→HTML engine (same library read-mode uses under the hood, but
// imported standalone — react-native-markdown-display's wrapper pulls RN native
// modules that can't load in jest, and this transform must run in tests too).
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
// TOOLBAR LIVES AT THE SCREEN ROOT, NOT HERE. tentap's <Toolbar> is a
// keyboard-sticky bar that must sit at the bottom of the SCREEN to float above
// the keyboard — nested inside the note screen's ScrollView it can never show
// (it self-hides unless isKeyboardUp && isFocused, and its absolute positioning
// resolves against the wrong ancestor). So this component renders ONLY <RichText>
// and hands its editor bridge up via onEditorReady; notes/[id].tsx renders
// <Toolbar editor={bridge}/> in an absolute-bottom view at the screen root.
//
//   mount:    onEditorReady(bridge)   → screen shows the toolbar
//   unmount:  onEditorReady(null)     → screen hides it (covers the 409 keyed
//             remount AND the ErrorBoundary→TextInput crash fallback)
//
// ⚠️ VERIFY ON A DEV BUILD: the md↔html fidelity for the supported subset
// (bold/italic/headings/lists/links/code). Unsupported constructs (tables, deep
// nesting) should round-trip as text, not be dropped. This component is
// default-OFF and wrapped in an ErrorBoundary, so a wrong guess here degrades to
// the plain TextInput rather than breaking note editing.
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
  /**
   * Hands the editor bridge up so the screen can render <Toolbar> at its root
   * (see header). Called with the bridge on mount and `null` on unmount.
   */
  onEditorReady?: (editor: EditorBridge | null) => void
  editable?: boolean
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

export const RichNoteEditor = forwardRef<RichNoteEditorHandle, RichNoteEditorProps>(
  function RichNoteEditor({ initialMarkdown, onChange, onEditorReady, editable = true }, ref) {
    const initialHTML = useMemo(() => md.render(initialMarkdown ?? ''), [initialMarkdown])

    const editor = useEditorBridge({
      autofocus: false,
      avoidIosKeyboard: true,
      editable,
      initialContent: initialHTML,
      // Fire the parent's dirty signal on any content update.
      onChange,
    })

    // Hand the bridge up for the screen-root <Toolbar>; clear it on unmount so a
    // 409 remount or an ErrorBoundary fallback can't leave an orphaned toolbar.
    useEffect(() => {
      onEditorReady?.(editor)
      return () => onEditorReady?.(null)
    }, [editor, onEditorReady])

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
      </View>
    )
  },
)

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 240, backgroundColor: colors.surface },
})
