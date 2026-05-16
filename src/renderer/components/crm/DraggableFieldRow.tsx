/**
 * DraggableFieldRow — shared wrapper for field rows in CRM properties panels.
 *
 *   ┌─ sectionedFieldRow ─────────────────────────────────────────────┐
 *   │  [⠿ drag handle, when isEditing]   [children]                   │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Renders the .sectionedFieldRow wrapper with HTML5 drag attrs + optional
 * .dragHandle indicator when editing. The .dragOverFieldIndicator class is
 * applied when isDragTarget is true (caller's responsibility to compute).
 *
 * Caller owns drag state (which field is dragging, drop targets) and passes
 * simple callbacks. Pattern duplicated across CompanyFieldSections (L293, L367,
 * L479+) and ContactPropertiesPanel renderSectionedFields (L926+); both now
 * delegate here.
 */

import { type DragEvent, type ReactNode } from 'react'
import styles from './atoms.module.css'

interface DraggableFieldRowProps {
  isEditing: boolean
  isDragTarget: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function DraggableFieldRow({
  isEditing,
  isDragTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  children,
}: DraggableFieldRowProps) {
  return (
    <div
      className={`${styles.sectionedFieldRow} ${isDragTarget ? styles.dragOverFieldIndicator : ''}`}
      draggable={isEditing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {isEditing && <span className={styles.dragHandle}>⠿</span>}
      {children}
    </div>
  )
}
