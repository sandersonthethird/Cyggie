/**
 * TextFilter — per-column filter for 'text' column type.
 * Case-insensitive contains match. Live onChange on every keystroke.
 * URL param: ?field_q=search
 */
import { useEffect, useRef } from 'react'
import styles from './TextFilter.module.css'

export interface TextFilterProps {
  value: string
  onChange: (v: string) => void
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  label: string
}

export function TextFilter({ value, onChange, isOpen, onOpen, onClose, label }: TextFilterProps) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [isOpen, onClose])

  const isActive = value.trim().length > 0
  const badge = value.length > 6 ? value.slice(0, 6) + '…' : value

  return (
    <span className={styles.wrap} ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        className={`${styles.btn} ${isActive ? styles.btnActive : ''}`}
        onClick={() => (isOpen ? onClose() : onOpen())}
        title={`Filter by ${label}`}
        type="button"
      >
        ▿{isActive && <span className={styles.badge}>{badge}</span>}
      </button>
      {isOpen && (
        <div className={styles.dropdown}>
          <input
            ref={inputRef}
            className={styles.textInput}
            type="text"
            placeholder="contains…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') onClose()
            }}
          />
          {isActive && (
            <button
              className={styles.clearBtn}
              type="button"
              onClick={() => { onChange(''); onClose() }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </span>
  )
}
