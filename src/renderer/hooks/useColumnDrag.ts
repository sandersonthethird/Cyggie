/**
 * useColumnDrag — shared hook for drag-and-drop column reordering.
 *
 * Handles: drag state, ghost suppression, drop-target highlighting,
 * child-element flicker guard, 60fps onDragOver dedup, anchor protection.
 *
 * State machine:
 *   IDLE ──onDragStart(key)──► DRAGGING ──onDrop(target)──► IDLE
 *                                │           (reorder + save)
 *                                └──onDragEnd()──► IDLE
 *                                   (cancel, no reorder)
 *
 * Callers pass `saveKeys` as a stable reference (module-level or useCallback []).
 */
import { useState, useRef, useCallback } from 'react'

/**
 * Reorder an array by moving `from` to be immediately before `to`.
 * Returns the same array reference if no move is needed.
 */
export function reorder(keys: string[], from: string, to: string): string[] {
  if (from === to) return keys
  const result = keys.filter((k) => k !== from)
  const toIdx = result.indexOf(to)
  if (toIdx === -1) return keys
  result.splice(toIdx, 0, from)
  return result
}

export interface ColumnDragProps {
  draggable: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

const NOOP_DRAG_PROPS: ColumnDragProps = {
  draggable: false,
  onDragStart: () => {},
  onDragOver: () => {},
  onDragLeave: () => {},
  onDrop: () => {},
  onDragEnd: () => {},
}

export function useColumnDrag(
  visibleKeys: string[],
  onVisibleKeysChange: (keys: string[]) => void,
  saveKeys: (keys: string[]) => void,
  anchorKey: string
): {
  draggingKey: string | null
  dragOverKey: string | null
  getDragProps: (key: string) => ColumnDragProps
} {
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  // Refs mirror state for synchronous reads in callbacks — avoids stale closures
  // and enables onDragOver dedup without adding state to the dep array.
  const draggingKeyRef = useRef<string | null>(null)
  const dragOverKeyRef = useRef<string | null>(null)

  // visibleKeys ref so onDrop always reads the latest value without recreating callbacks.
  const visibleKeysRef = useRef(visibleKeys)
  visibleKeysRef.current = visibleKeys

  const getDragProps = useCallback((key: string): ColumnDragProps => {
    if (key === anchorKey) return NOOP_DRAG_PROPS

    return {
      draggable: true,

      onDragStart(e: React.DragEvent) {
        e.dataTransfer.effectAllowed = 'move'
        // Suppress default ghost image — CSS opacity (.dragging) + drop indicator
        // (.dragOver box-shadow) provide all the visual feedback needed.
        e.dataTransfer.setDragImage(new Image(), 0, 0)
        draggingKeyRef.current = key
        setDraggingKey(key)
      },

      onDragOver(e: React.DragEvent) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (key === anchorKey) return
        // Dedup: onDragOver fires ~60fps — skip state update when key hasn't changed.
        if (dragOverKeyRef.current === key) return
        dragOverKeyRef.current = key
        setDragOverKey(key)
      },

      onDragLeave(e: React.DragEvent) {
        // Child-element guard: the browser fires onDragLeave when the cursor moves
        // from the cell background into a child (sort arrow, filter icon, resize handle).
        // contains(relatedTarget) returns true in that case — bail to prevent flicker.
        if ((e.currentTarget as Element).contains(e.relatedTarget as Node)) return
        dragOverKeyRef.current = null
        setDragOverKey(null)
      },

      onDrop(e: React.DragEvent) {
        e.preventDefault()
        const from = draggingKeyRef.current
        if (!from || key === anchorKey) {
          draggingKeyRef.current = null
          dragOverKeyRef.current = null
          setDraggingKey(null)
          setDragOverKey(null)
          return
        }
        const newKeys = reorder(visibleKeysRef.current, from, key)
        if (newKeys !== visibleKeysRef.current) {
          onVisibleKeysChange(newKeys)
          saveKeys(newKeys)
        }
        draggingKeyRef.current = null
        dragOverKeyRef.current = null
        setDraggingKey(null)
        setDragOverKey(null)
      },

      onDragEnd() {
        draggingKeyRef.current = null
        dragOverKeyRef.current = null
        setDraggingKey(null)
        setDragOverKey(null)
      },
    }
  }, [anchorKey, onVisibleKeysChange, saveKeys])

  return { draggingKey, dragOverKey, getDragProps }
}
