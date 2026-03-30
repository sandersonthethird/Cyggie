/**
 * useDigestItemAutoSave — auto-save state machine for digest item text fields.
 *
 * State machine:
 *
 *   collapsed ──► expand ──► { expanded=true, hasEdited=false }
 *                                │
 *                       user types ──► markEdited() → hasEdited=true
 *                                │         └─► debouncedDraft changes
 *                                │               └─► auto-save fires (while expanded AND hasEdited=true)
 *                                │
 *                       click outside ──► flushSave(currentMd)
 *                                           │
 *                                      hasEdited?
 *                                        ├─ YES ──► onSave(currentMd)
 *                                        └─ NO  ──► skip (prevents wiping DB
 *                                                   content that was set externally
 *                                                   while this component had stale state)
 *
 * Motivation: DigestItemNotes mounts with content=null (stale UI state) even when
 * the DB has a brief set by background enrichment. Without dirty tracking, the
 * collapse handler unconditionally saves '' → brief=null, wiping the DB brief.
 *
 * Used by: DigestItemNotes
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebounce } from './useDebounce'

interface UseDigestItemAutoSaveOptions {
  content: string | null
  onSave: (content: string) => void
  expanded: boolean
}

interface UseDigestItemAutoSaveReturn {
  draft: string
  setDraft: (md: string) => void
  /** Call in editor's onUpdate to mark content as user-edited. */
  markEdited: () => void
  /** Call in collapse handler. Only calls onSave if user has edited since last expand. */
  flushSave: (currentMd: string) => void
}

export function useDigestItemAutoSave({
  content,
  onSave,
  expanded,
}: UseDigestItemAutoSaveOptions): UseDigestItemAutoSaveReturn {
  const [draft, setDraft] = useState(content ?? '')
  const debouncedDraft = useDebounce(draft, 800)
  const hasEditedRef = useRef(false)
  const latestOnSave = useRef(onSave)
  latestOnSave.current = onSave

  // Sync content from parent when collapsed
  useEffect(() => {
    if (!expanded) {
      setDraft(content ?? '')
    }
  }, [content, expanded])

  // Reset dirty flag on each new expand
  useEffect(() => {
    if (expanded) {
      hasEditedRef.current = false
    }
  }, [expanded])

  // Auto-save on debounced typing — only fires when expanded AND user has edited
  useEffect(() => {
    if (!expanded || !hasEditedRef.current) return
    latestOnSave.current(debouncedDraft)
  }, [debouncedDraft]) // eslint-disable-line react-hooks/exhaustive-deps

  const markEdited = useCallback(() => {
    hasEditedRef.current = true
  }, [])

  const flushSave = useCallback((currentMd: string) => {
    setDraft(currentMd)
    if (hasEditedRef.current) {
      latestOnSave.current(currentMd)
    }
  }, [])

  return { draft, setDraft, markEdited, flushSave }
}
