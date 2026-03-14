import { useCallback, useEffect, useRef, useState } from 'react'

interface UsePanelResizeOptions {
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
}

export function usePanelResize({
  defaultWidth = 300,
  minWidth = 180,
  maxWidth = 600,
}: UsePanelResizeOptions = {}) {
  const [leftWidth, setLeftWidth] = useState(defaultWidth)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true
      startX.current = e.clientX
      startWidth.current = leftWidth
      e.preventDefault()
    },
    [leftWidth]
  )

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return
      const delta = e.clientX - startX.current
      const next = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta))
      setLeftWidth(next)
    }
    function onMouseUp() {
      dragging.current = false
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, maxWidth])

  return { leftWidth, dividerProps: { onMouseDown } }
}
