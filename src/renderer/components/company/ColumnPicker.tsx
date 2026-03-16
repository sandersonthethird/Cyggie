import { useEffect, useRef, useState } from 'react'
import type { ColumnDef } from '../crm/tableUtils'
import styles from './ColumnPicker.module.css'

interface ColumnPickerProps {
  visibleKeys: string[]
  /** All possible column definitions (entity-specific, passed from parent). */
  allDefs: ColumnDef[]
  onChange: (visibleKeys: string[]) => void
  /** Called after each toggle to persist the new key list (entity-specific save). */
  onSave: (visibleKeys: string[]) => void
  onCreateField?: () => void
}

export function ColumnPicker({ visibleKeys, allDefs, onChange, onSave, onCreateField }: ColumnPickerProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Click-outside to close
  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  function toggle(key: string) {
    const next = visibleKeys.includes(key)
      ? visibleKeys.filter((k) => k !== key)
      : [...visibleKeys, key]
    onSave(next)
    onChange(next)
  }

  // Always keep the first column (name anchor) visible
  const anchorKey = allDefs[0]?.key
  const toggleable = allDefs.filter((c) => c.key !== anchorKey)

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        title="Add or remove columns"
      >
        +
      </button>
      {open && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownHeader}>Columns</div>
          {toggleable.map((col) => {
            const on = visibleKeys.includes(col.key)
            return (
              <div key={col.key} className={styles.item} onClick={() => toggle(col.key)}>
                <span className={`${styles.itemCheck} ${on ? styles.itemCheckOn : ''}`}>
                  {on ? '✓' : ''}
                </span>
                {col.label}
              </div>
            )
          })}
          {onCreateField && (
            <>
              <div className={styles.divider} />
              <div className={styles.item} onClick={() => { setOpen(false); onCreateField() }}>
                <span className={styles.itemCheck} />
                New field…
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
