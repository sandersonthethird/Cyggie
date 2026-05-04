import { useEdgeResize } from '../../hooks/useEdgeResize'
import { useChatPanelStore, DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH } from '../../stores/chat-panel.store'
import { useEffect } from 'react'
import styles from './ResizeHandle.module.css'

/**
 * Left-edge drag handle for the right-anchored chat panel.
 *
 *   panel left edge
 *      │
 *      ▼
 *   ┌──┬───────────────────┐
 *   │  │                   │
 *   │░░│      panel        │   drag horizontally to resize
 *   │  │                   │   double-click → reset to DEFAULT_PANEL_WIDTH
 *   └──┴───────────────────┘
 *
 * Initial width pulls from the panel store; commits propagate back via setWidth.
 */
export function ResizeHandle() {
  const storedWidth = useChatPanelStore((s) => s.width)
  const setStoreWidth = useChatPanelStore((s) => s.setWidth)

  const { width, isDragging, dividerProps, setWidth } = useEdgeResize({
    defaultWidth: DEFAULT_PANEL_WIDTH,
    minWidth: MIN_PANEL_WIDTH,
    maxWidth: MAX_PANEL_WIDTH,
    side: 'right-anchored',
    onCommit: (w) => setStoreWidth(w),
  })

  // Sync with store changes (e.g. width persisted from a prior session).
  useEffect(() => {
    if (storedWidth !== width) setWidth(storedWidth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedWidth])

  // Live-write width during drag so the parent panel grows/shrinks in real time.
  useEffect(() => {
    if (isDragging && width !== storedWidth) setStoreWidth(width)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width])

  return (
    <div
      className={`${styles.handle} ${isDragging ? styles.handleDragging : ''}`}
      {...dividerProps}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
    />
  )
}
