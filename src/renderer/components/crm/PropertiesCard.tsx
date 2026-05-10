import type { ReactNode } from 'react'
import styles from './PropertiesCard.module.css'

interface PropertiesCardProps {
  /** Top band slot — pipeline stepper for companies, relationship-strength for contacts. */
  topBand?: ReactNode
  /** Stack of <CollapsibleSection> children (or any vertical section markup). */
  children: ReactNode
  /** Footer node — typically <PropertiesCardFooter>. */
  footer?: ReactNode
  className?: string
}

/**
 * Variant C shell: white card with optional top band, vertical section stack,
 * and optional footer separated by hairlines.
 *
 * Both CompanyPropertiesPanel and ContactPropertiesPanel render their property
 * area inside this shell. The shell itself is purely structural — the panel
 * configures the band, sections, and footer.
 */
export function PropertiesCard({ topBand, children, footer, className }: PropertiesCardProps) {
  return (
    <div className={[styles.card, className].filter(Boolean).join(' ')}>
      {topBand && <div className={styles.topBand}>{topBand}</div>}
      <div className={styles.sections}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  )
}

interface PropertiesCardFooterProps {
  hiddenCount: number
  onShowHidden?: () => void
  onAddProperty?: () => void
  /** Optional extra slot rendered between the hidden link and the add button (e.g. Edit toggle). */
  extra?: ReactNode
}

export function PropertiesCardFooter({ hiddenCount, onShowHidden, onAddProperty, extra }: PropertiesCardFooterProps) {
  return (
    <>
      {hiddenCount > 0 && onShowHidden ? (
        <button type="button" className={styles.hiddenLink} onClick={onShowHidden}>
          Show {hiddenCount} hidden field{hiddenCount === 1 ? '' : 's'}
        </button>
      ) : (
        <span aria-hidden />
      )}
      {extra && <span className={styles.footerExtra}>{extra}</span>}
      {onAddProperty && (
        <button type="button" className={styles.addPropBtn} onClick={onAddProperty}>
          + Add property
        </button>
      )}
    </>
  )
}
