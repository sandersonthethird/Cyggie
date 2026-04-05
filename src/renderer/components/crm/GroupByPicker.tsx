/**
 * GroupByPicker — dropdown button for selecting the group-by field.
 *
 * Self-contained: uses the same portal + click-outside pattern as the column
 * header context menu. Deferred refactor: extract to shared DropdownButton
 * base once ColumnPicker is also migrated (see TODOS.md).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GroupableField } from '../company/companyColumns'
import styles from './GroupByPicker.module.css'

interface GroupByPickerProps {
  value: string | null
  fields: GroupableField[]
  onChange: (key: string | null) => void
}

export function GroupByPicker({ value, fields, onChange }: GroupByPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const activeField = value ? fields.find((f) => f.key === value) : null
  const label = activeField ? `Group: ${activeField.label}` : 'Group: None'

  useEffect(() => {
    if (!isOpen) return
    function handle(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [isOpen])

  // Position the menu below the trigger button
  function getMenuStyle(): React.CSSProperties {
    if (!triggerRef.current) return {}
    const rect = triggerRef.current.getBoundingClientRect()
    return {
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      zIndex: 1000
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        className={`${styles.trigger} ${value ? styles.triggerActive : ''}`}
        onClick={() => setIsOpen((v) => !v)}
      >
        {label} ▾
      </button>

      {isOpen && createPortal(
        <div ref={menuRef} className={styles.menu} style={getMenuStyle()}>
          <button
            className={`${styles.option} ${!value ? styles.optionActive : ''}`}
            onClick={() => { onChange(null); setIsOpen(false) }}
          >
            None
          </button>
          {fields.map((field) => (
            <button
              key={field.key}
              className={`${styles.option} ${value === field.key ? styles.optionActive : ''}`}
              onClick={() => { onChange(field.key); setIsOpen(false) }}
            >
              {field.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
