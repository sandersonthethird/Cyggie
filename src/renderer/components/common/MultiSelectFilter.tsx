import { useEffect, useRef, useState } from 'react'
import styles from './MultiSelectFilter.module.css'

interface MultiSelectFilterProps<T extends string> {
  options: { value: T; label: string; color?: string }[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
  allLabel: string
  fixedLabel?: string // When provided, always show this text on the button regardless of selection
}

export default function MultiSelectFilter<T extends string>({
  options,
  selected,
  onChange,
  allLabel,
  fixedLabel
}: MultiSelectFilterProps<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = (value: T) => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(next)
  }

  const label = fixedLabel ?? (selected.size === 0
    ? allLabel
    : options.filter((o) => selected.has(o.value)).map((o) => o.label).join(', '))

  return (
    <div ref={ref} className={styles.wrapper}>
      <button
        className={`${styles.btn} ${selected.size > 0 ? styles.active : ''}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className={styles.label}>{label}</span>
        <span className={styles.caret}>▾</span>
      </button>
      {open && (
        <div className={styles.dropdown}>
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
        </div>
      )}
    </div>
  )
}
