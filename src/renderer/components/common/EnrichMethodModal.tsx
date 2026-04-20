import { createPortal } from 'react-dom'
import { useCallback, useEffect } from 'react'
import styles from './EnrichMethodModal.module.css'

export interface EnrichMethod {
  icon: string
  label: string
  description?: string
  onClick: () => void
  disabled?: boolean
}

interface EnrichMethodModalProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  methods: EnrichMethod[]
}

/**
 * Modal that presents available enrichment methods for a record.
 * Used by both Company and Contact detail panels.
 *
 * Company methods: PDF, URL, meetings, notes, emails
 * Contact methods: meetings, LinkedIn enrich/find
 */
export function EnrichMethodModal({ open, onClose, title, subtitle, methods }: EnrichMethodModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleMethodClick = useCallback((method: EnrichMethod) => {
    if (method.disabled) return
    onClose()
    method.onClick()
  }, [onClose])

  if (!open) return null

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles.modal}>
        <div className={styles.title}>{title}</div>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}

        <div className={styles.methods}>
          {methods.map((method, i) => (
            <button
              key={i}
              className={styles.method}
              onClick={() => handleMethodClick(method)}
              disabled={method.disabled}
            >
              <span className={styles.methodIcon}>{method.icon}</span>
              <div className={styles.methodText}>
                <span className={styles.methodLabel}>{method.label}</span>
                {method.description && (
                  <span className={styles.methodDesc}>{method.description}</span>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className={styles.cancelRow}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
