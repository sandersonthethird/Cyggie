import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'
import type { FindMatch } from './useFindInPage'

/**
 * useTiptapFindHighlight — push find-in-page matches into a TipTap editor's
 * FindHighlight extension as <mark> decorations.
 *
 *   matches / activeIndex ──► setFindMatches ──► FindHighlight renders
 *                                                <mark> / <mark class="markActive">
 *   enabled === false      ──► clearFindMatches (e.g. while a summary streams,
 *                              before a TipTap editor holds the final content)
 *
 * Guard: tiptap v3's useEditor destroys + recreates the editor on dep change.
 * During that transition the returned `editor` can be truthy but have a null
 * `.commands` (internal view/state not yet rewired) — calling a command then
 * throws. Bail if the editor is missing, destroyed, or not yet rewired.
 *
 * Extracted from the identical wiring in CompanyMemo / MeetingDetail so all
 * TipTap find surfaces share one guarded implementation.
 */
export function useTiptapFindHighlight(
  editor: Editor | null,
  matches: FindMatch[],
  activeIndex: number,
  enabled = true,
): void {
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.commands) return
    if (!enabled) {
      editor.commands.clearFindMatches()
      return
    }
    editor.commands.setFindMatches(matches, activeIndex)
  }, [editor, matches, activeIndex, enabled])
}
