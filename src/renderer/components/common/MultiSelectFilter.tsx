import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import styles from './MultiSelectFilter.module.css'

interface MultiSelectFilterProps<T extends string> {
  options: { value: T; label: string; color?: string }[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
  allLabel: string
  fixedLabel?: string // When provided, always show this text on the button regardless of selection
  portal?: boolean    // Render dropdown via document.body portal (escapes overflow-x:auto clipping)
  variant?: 'header'  // Strip button border/bg; use header typography
}

export default function MultiSelectFilter<T extends string>({
  options,
  selected,
  onChange,
  allLabel,
  fixedLabel,
  portal,
  variant,
}: MultiSelectFilterProps<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      // Always check wrapper (covers button + non-portal dropdown)
      if (ref.current?.contains(e.target as Node)) return
      // Portal-only: dropdown lives in document.body, not inside wrapper
      if (portal && dropdownRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, portal])

  const toggle = (value: T) => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(next)
  }

  const label = fixedLabel ?? (selected.size === 0
    ? allLabel
    : options.filter((o) => selected.has(o.value)).map((o) => o.label).join(', '))

  const isActive = selected.size > 0
  const btnClass = variant === 'header'
    ? `${styles.headerBtn} ${isActive ? styles.active : ''}`
    : `${styles.btn} ${isActive ? styles.active : ''}`

  const dropdownContent = (
    <>
      {options.map((opt) => (
        <label key={opt.value} className={styles.option}>
          <input
            type="checkbox"
            checked={selected.has(opt.value)}
            onChange={() => toggle(opt.value)}
            className={styles.checkbox}
          />
          {opt.color && <span className={styles.colorDot} style={{ background: opt.color }} />}
          {opt.label}
        </label>
      ))}
      {selected.size > 0 && (
        <button
          className={styles.clear}
          onClick={() => onChange(new Set())}
          type="button"
        >
          Clear
        </button>
      )}
    </>
  )

  return (
    <div ref={ref} className={styles.wrapper}>
      <button
        ref={btnRef}
        className={btnClass}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.caret}>▾</span>
      </button>
      {open && portal ? (
        (() => {
          const rect = btnRef.current?.getBoundingClientRect()
          if (!rect) return null
          return ReactDOM.createPortal(
            <div
              ref={dropdownRef}
              className={styles.dropdown}
              style={{
                position: 'fixed',
                top: rect.bottom + 4,
                left: rect.left,
                zIndex: 1000,
                minWidth: rect.width,
              }}
            >
              {dropdownContent}
            </div>,
            document.body
          )
        })()
      ) : open ? (
        <div className={styles.dropdown}>
          {dropdownContent}
        </div>
      ) : null}
    </div>
  )
}
