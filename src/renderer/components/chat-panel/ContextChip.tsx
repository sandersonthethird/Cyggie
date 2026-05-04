import { useEffect, useRef, useState } from 'react'
import type { ContextOption } from '../../../shared/types/chat'
import styles from './ContextChip.module.css'

interface ContextChipProps {
  /** The single chip / dropdown source. Empty array hides the chip. */
  contextOptions: ContextOption[]
  /** Currently selected option's id, or null for the "Global" / unattached state. */
  activeId: string | null
  onSelect: (option: ContextOption | null) => void
  onDismiss: () => void
}

/**
 * Above-the-composer chip showing "Including context: <entity>".
 *
 * If multiple options exist (multi-attendee meeting), expands to a dropdown.
 * Otherwise renders a flat chip. The dismiss × removes context for the
 * lifetime of this chat (handled by the caller via useChatPanelStore).
 */
export function ContextChip({ contextOptions, activeId, onSelect, onDismiss }: ContextChipProps) {
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

  if (contextOptions.length === 0) return null

  const active = contextOptions.find((o) => o.id === activeId) ?? contextOptions[0]
  const multiple = contextOptions.length > 1
  const initial = active.name.charAt(0).toUpperCase() || '?'
  const tone = active.type === 'company' ? styles.toneCompany : styles.toneContact

  return (
    <div className={styles.wrap} ref={ref}>
      <span className={styles.label}>Including context:</span>
      <button
        type="button"
        className={styles.chip}
        onClick={() => multiple && setOpen((v) => !v)}
        aria-haspopup={multiple ? 'listbox' : undefined}
        aria-expanded={multiple ? open : undefined}
        title={active.name}
      >
        <span className={`${styles.chipIcon} ${tone}`}>{initial}</span>
        <span className={styles.chipName}>{active.name}</span>
        {multiple && <span className={styles.caret}>▾</span>}
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={onDismiss}
        title="Remove context for this chat"
        aria-label="Remove context"
      >
        ×
      </button>
      {open && multiple && (
        <div className={styles.dropdown} role="listbox">
          {contextOptions.map((opt) => (
            <button
              key={`${opt.type}:${opt.id}`}
              className={`${styles.dropdownItem} ${opt.id === active.id ? styles.dropdownItemActive : ''}`}
              onClick={() => {
                onSelect(opt)
                setOpen(false)
              }}
            >
              {opt.type === 'company' ? '🏢' : '👤'} {opt.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
