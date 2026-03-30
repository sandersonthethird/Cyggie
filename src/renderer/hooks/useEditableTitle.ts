/**
 * useEditableTitle — shared click-to-edit title pattern for note surfaces.
 *
 * State machine:
 *
 *   VIEWING ──(handleTitleClick)──► EDITING
 *     savedTitleRef.current = titleDraft  (captured before any edits)
 *     titleRef.current?.focus()
 *
 *   EDITING ──(handleTitleBlur / Enter)──► VIEWING
 *     setEditingTitle(false)
 *     (titleDraft already saved via onChange → debounce in the parent hook)
 *
 *   EDITING ──(Escape)──► VIEWING
 *     setTitleDraft(savedTitleRef.current)  (revert to value before edit)
 *     setEditingTitle(false)
 */

import { useCallback, useRef, useState } from 'react'

export interface UseEditableTitleResult {
  editingTitle: boolean
  titleRef: React.RefObject<HTMLInputElement | null>
  handleTitleClick: () => void
  handleTitleBlur: () => void
  handleTitleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>, onEnter?: () => void) => void
}

export function useEditableTitle(
  titleDraft: string,
  setTitleDraft: (v: string) => void
): UseEditableTitleResult {
  const [editingTitle, setEditingTitle] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const savedTitleRef = useRef<string>('')

  const handleTitleClick = useCallback(() => {
    savedTitleRef.current = titleDraft
    setEditingTitle(true)
    // Focus is applied via useEffect in the consumer after state update,
    // or directly here on next tick so the input is in the DOM.
    requestAnimationFrame(() => titleRef.current?.focus())
  }, [titleDraft])

  const handleTitleBlur = useCallback(() => {
    setEditingTitle(false)
  }, [])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, onEnter?: () => void) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        setEditingTitle(false)
        onEnter?.()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setTitleDraft(savedTitleRef.current)
        setEditingTitle(false)
      }
    },
    [setTitleDraft]
  )

  return { editingTitle, titleRef, handleTitleClick, handleTitleBlur, handleTitleKeyDown }
}
