/**
 * HideableRow — shared wrapper for fields that can be hidden/restored.
 *
 *   ┌─ when showControls = isEditing || showAllFields ───────────────┐
 *   │  [field content]              [× hide]   or   [↺ restore]     │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * When `isHidden`, the content is rendered with reduced opacity
 * (`.fieldHidden`). The hide button only appears on hover (CSS-driven).
 *
 * showControls is derived internally from isEditing + showAllFields so both
 * callers can't diverge on the derivation (per eng-review decision 2A).
 *
 * Originally defined inline in ContactPropertiesPanel (L1033) and
 * CompanyFieldSections (L255). Identical behavior in both.
 */

import { type ReactNode } from 'react'
import styles from './atoms.module.css'

interface HideableRowProps {
  fieldKey: string
  isEmpty?: boolean
  isHidden: boolean
  isEditing: boolean
  showAllFields: boolean
  onHide: (fieldKey: string, isEmpty: boolean) => void
  onRestore: (fieldKey: string) => void
  children: ReactNode
}

export function HideableRow({
  fieldKey,
  isEmpty = false,
  isHidden,
  isEditing,
  showAllFields,
  onHide,
  onRestore,
  children,
}: HideableRowProps) {
  const showControls = isEditing || showAllFields

  return (
    <div className={`${styles.hideable} ${isHidden ? styles.fieldHidden : ''}`}>
      <div className={styles.hideableContent}>{children}</div>
      {showControls && (
        isHidden
          ? <button
              className={styles.restoreBtn}
              title="Restore field"
              onClick={() => onRestore(fieldKey)}
            >↺</button>
          : <button
              className={styles.hideBtn}
              title="Hide field"
              onClick={() => onHide(fieldKey, isEmpty)}
            >×</button>
      )}
    </div>
  )
}
