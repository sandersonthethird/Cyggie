import { useCallback, useEffect, useRef, useState } from 'react'

interface UseEdgeResizeOptions {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  /** 'left' = left-edge handle (drag right grows the panel — used by left-side panels).
   *  'right' = right-edge handle of a left-side panel.
   *  For a RIGHT-anchored panel resized via its LEFT edge, use 'right-anchored' so
   *  dragging right shrinks and dragging left grows. */
  side?: 'left' | 'right' | 'right-anchored'
  /** Optional: persist width changes (e.g. write to localStorage). Called after
   *  the user releases. */
  onCommit?: (width: number) => void
}

/**
 * Drag-to-resize hook with min/max clamping and double-click reset.
 *
 *   ┌───┬─────────────┐
 *   │ S │             │           startX, startWidth captured on mousedown
 *   │ I │   panel     │ ◀── handle on right edge
 *   │ D │             │           delta = mouseX - startX
 *   │ E │             │           width = clamp(startWidth ± delta, min, max)
 *   └───┴─────────────┘
 *
 * For a RIGHT-anchored panel resized via its LEFT edge (the side panel case),
 * the math is sign-flipped: dragging RIGHT shrinks the panel.
 */
export function useEdgeResize({
  defaultWidth = 400,
  minWidth = 320,
  maxWidth = 600,
  side = 'right-anchored',
  onCommit,
}: UseEdgeResizeOptions = {}) {
  const [width, setWidth] = useState(defaultWidth)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true
      setIsDragging(true)
      startX.current = e.clientX
      startWidth.current = width
      e.preventDefault()
    },
    [width]
  )

  const onDoubleClick = useCallback(() => {
    setWidth(defaultWidth)
    onCommit?.(defaultWidth)
  }, [defaultWidth, onCommit])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return
      const rawDelta = e.clientX - startX.current
      const delta = side === 'right-anchored' ? -rawDelta : rawDelta
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      setWidth(next)
    }
    function onMouseUp() {
      if (!dragging.current) return
      dragging.current = false
      setIsDragging(false)
      // Read the latest width via the setter and commit it once.
      setWidth((w) => {
        onCommit?.(w)
        return w
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, maxWidth, side, onCommit])

  return {
    width,
    isDragging,
    dividerProps: { onMouseDown, onDoubleClick },
    setWidth,
  }
}
