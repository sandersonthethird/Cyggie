import { forwardRef, useEffect, useImperativeHandle, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  RichText,
  useEditorBridge,
  TenTapStartKit,
  CoreBridge,
  type EditorBridge,
} from '@10play/tentap-editor'
// Pure-JS markdown→HTML engine (same library read-mode uses under the hood, but
// imported standalone — react-native-markdown-display's wrapper pulls RN native
// modules that can't load in jest, and this transform must run in tests too).
import MarkdownIt from 'markdown-it'
import TurndownService from 'turndown'

import { colors, type } from '../theme'

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

// Make the WYSIWYG editor LOOK LIKE the read view. tentap's content defaults to
// `font-size: 0.9rem` (≈14px) — smaller than read mode. We override the Tiptap
// content root (`.ProseMirror`) via CoreBridge.configureCSS, deriving every value
// from `theme.ts` (NO magic numbers) so it tracks `richMarkdownStyles`
// (lib/markdown.tsx) — the read-view typography this must mirror.
const NOTE_CSS = `
  .ProseMirror { font-size: ${type.body + 1}px; line-height: 22px; color: ${colors.text}; }
  .ProseMirror a { color: ${colors.crimson}; }
  .ProseMirror h1 { font-size: ${type.h2}px; font-weight: 700; }
  .ProseMirror h2 { font-size: ${type.h2 - 2}px; font-weight: 700; }
  .ProseMirror h3 { font-size: ${type.body + 2}px; font-weight: 600; }
  .ProseMirror code { background: ${colors.surface3}; border-radius: 4px; padding: 0 4px; }
`

export const RichNoteEditor = forwardRef<RichNoteEditorHandle, RichNoteEditorProps>(
  function RichNoteEditor({ initialMarkdown, onChange, onEditorReady, editable = true }, ref) {
    const initialHTML = useMemo(() => md.render(initialMarkdown ?? ''), [initialMarkdown])

    const editor = useEditorBridge({
      autofocus: false,
      avoidIosKeyboard: true,
      editable,
      initialContent: initialHTML,
      // Grow to fit content (outer ScrollView scrolls) instead of a fixed 240px box.
      dynamicHeight: true,
      // Default bridges + our read-matching content CSS (see NOTE_CSS).
      bridgeExtensions: [...TenTapStartKit, CoreBridge.configureCSS(NOTE_CSS)],
      // Fire the parent's dirty signal on any content update.
      onChange,
    })

    // Hand the bridge up for the screen-root <Toolbar>; clear it on unmount so a
    // 409 remount or an ErrorBoundary fallback can't leave an orphaned toolbar.
    //
    // ⚠️ MOUNT-ONLY (empty deps), NOT [editor]. tentap's useEditorBridge rebuilds
    // the editor object on EVERY render (no internal memo), so depending on
    // `editor` identity here re-fires the effect each render → setToolbarEditor →
    // re-render → loop ("Maximum update depth exceeded"), which crashes the screen
    // the instant the editor mounts (e.g. a new note that auto-enters edit mode).
    // The instance wraps stable refs (webviewRef/editorStateRef), so the first one
    // is valid for the toolbar's whole lifetime; a 409 keyed remount fully
    // remounts this component and re-runs the effect with the fresh bridge.
    useEffect(() => {
      onEditorReady?.(editor)
      return () => onEditorReady?.(null)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

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
  // No flex:1 — with dynamicHeight the editor sizes to its content; keep a
  // minHeight as an empty-note tap target.
  root: { minHeight: 200, backgroundColor: colors.surface },
})
