import { useEffect, useRef } from 'react'
import styles from './HeaderFilter.module.css'

interface HeaderFilterProps {
  options: { value: string; label: string }[]  // already excludes '' sentinel
  activeValues: string[]
  onToggle: (value: string) => void
  isOpen: boolean
  onOpen: () => void    // called on button click — parent sets filterOpenCol
  onClose: () => void   // called on outside-click — parent sets filterOpenCol = null
  label: string         // column label for aria-label
}

export function HeaderFilter({
  options,
  activeValues,
  onToggle,
  isOpen,
  onOpen,
  onClose,
  label
}: HeaderFilterProps) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [isOpen, onClose])

  return (
    <div ref={wrapRef} className={styles.wrap} onClick={(e) => e.stopPropagation()}>
      <button
        className={`${styles.btn} ${activeValues.length > 0 ? styles.btnActive : ''}`}
        onClick={(e) => { e.stopPropagation(); onOpen() }}
        aria-label={`Filter by ${label}`}
        title={`Filter by ${label}`}
      >
        ▾
        {activeValues.length > 0 && (
          <span className={styles.badge}>{activeValues.length}</span>
        )}
      </button>
      {isOpen && (
        <div className={styles.dropdown}>
          {options.map((opt) => (
            <label key={opt.value} className={styles.option}>
              <input
                type="checkbox"
                checked={activeValues.includes(opt.value)}
                onChange={() => onToggle(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
