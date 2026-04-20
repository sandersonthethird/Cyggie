import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useSmartBack } from '../../hooks/useSmartBack'
import styles from './RecordTopBar.module.css'

export interface Breadcrumb {
  label: string
  /** If provided, crumb is a clickable link */
  href?: string
}

interface RecordTopBarProps {
  /** Label shown on the back button (e.g. "Prospects") */
  backLabel?: string
  /** Route to fall back to when there's no history (e.g. "/companies") */
  backFallback: string
  /** Breadcrumb trail — last item is rendered bold as the current page */
  breadcrumbs: Breadcrumb[]
  /** Right-aligned action buttons */
  actions?: ReactNode
}

export function RecordTopBar({ backLabel, backFallback, breadcrumbs, actions }: RecordTopBarProps) {
  const navigate = useNavigate()
  const { label, goBack, canGoForward, goForward } = useSmartBack(backFallback, backLabel)

  return (
    <div className={styles.topBar}>
      <button className={styles.backBtn} onClick={goBack}>
        <ChevronLeft size={14} strokeWidth={1.8} />
        {label}
      </button>

      {canGoForward && (
        <button className={styles.fwdBtn} onClick={goForward} title="Forward">
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
      )}

      <div className={styles.divider} />

      <div className={styles.breadcrumbs}>
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1
          return (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span className={styles.crumbSep}>/</span>}
              {isLast ? (
                <span className={styles.crumbCurrent}>{crumb.label}</span>
              ) : crumb.href ? (
                <button className={styles.crumbLink} onClick={() => navigate(crumb.href!)}>
                  {crumb.label}
                </button>
              ) : (
                <span className={styles.crumbLink}>{crumb.label}</span>
              )}
            </span>
          )
        })}
      </div>

      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
