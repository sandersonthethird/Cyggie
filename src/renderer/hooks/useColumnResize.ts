/**
 * useColumnResize — shared hook for column-width drag-resize.
 *
 * Handles: resize refs, global mousemove/mouseup listeners, auto-save on mouseup.
 * Callers pass `initialWidths` (from localStorage) and `saveWidths` (to localStorage).
 *
 * Stability contract: `saveWidths` MUST be a stable reference (module-level export).
 */
import { useState, useCallback, useEffect, useRef } from 'react'

export function useColumnResize(
  initialWidths: Record<string, number>,
  saveWidths: (w: Record<string, number>) => void
): {
  colWidths: Record<string, number>
  onResizeMouseDown: (e: React.MouseEvent, colKey: string, currentW: number) => void
} {
  const [colWidths, setColWidths] = useState<Record<string, number>>(initialWidths)

  const resizeDragging = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(0)
  const resizeKey = useRef('')

  const onResizeMouseDown = useCallback((e: React.MouseEvent, colKey: string, currentW: number) => {
    e.preventDefault()
    e.stopPropagation()
    resizeDragging.current = true
    resizeStartX.current = e.clientX
    resizeStartW.current = currentW
    resizeKey.current = colKey
  }, [])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizeDragging.current) return
      const delta = e.clientX - resizeStartX.current
      const newW = Math.max(60, resizeStartW.current + delta)
      setColWidths((prev) => ({ ...prev, [resizeKey.current]: newW }))
    }
    function onMouseUp() {
      if (!resizeDragging.current) return
      resizeDragging.current = false
      setColWidths((prev) => {
        saveWidths(prev)
        return prev
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [saveWidths])

  return { colWidths, onResizeMouseDown }
}
