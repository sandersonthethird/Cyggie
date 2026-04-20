import { useCallback, type ReactNode } from 'react'
import { usePreferencesStore } from '../../stores/preferences.store'
import styles from './CollapsibleSection.module.css'

interface CollapsibleSectionProps {
  /** Unique key for persisting open/closed state (e.g. 'cyggie:company-collapsed:abc123') */
  prefsKey: string
  /** Key within the persisted array that identifies this section */
  sectionKey: string
  /** Section header text (rendered uppercase) */
  title: string
  /** Whether the section starts open (default: true) */
  defaultOpen?: boolean
  /** Optional extra content rendered in the header row (e.g. action buttons) */
  headerRight?: ReactNode
  children: ReactNode
}

/**
 * A section with a collapsible header. Open/closed state is persisted
 * per-entity via usePreferencesStore.
 *
 * The preference is stored as an array of collapsed section keys under `prefsKey`.
 * A section is collapsed if its `sectionKey` appears in the array.
 */
export function CollapsibleSection({
  prefsKey,
  sectionKey,
  title,
  defaultOpen = true,
  headerRight,
  children,
}: CollapsibleSectionProps) {
  const { getJSON, setJSON } = usePreferencesStore()
  const collapsedKeys = getJSON<string[]>(prefsKey, defaultOpen ? [] : [sectionKey])
  const isCollapsed = collapsedKeys.includes(sectionKey)

  const toggle = useCallback(() => {
    const next = isCollapsed
      ? collapsedKeys.filter((k) => k !== sectionKey)
      : [...collapsedKeys, sectionKey]
    setJSON(prefsKey, next)
  }, [isCollapsed, collapsedKeys, sectionKey, prefsKey, setJSON])

  return (
    <div className={styles.section}>
      <div className={styles.header} onClick={toggle}>
        <span>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {headerRight}
          <button
            className={`${styles.toggleBtn} ${isCollapsed ? styles.toggleBtnCollapsed : ''}`}
            onClick={(e) => { e.stopPropagation(); toggle() }}
            title={isCollapsed ? 'Expand section' : 'Collapse section'}
          >
            ▼
          </button>
        </div>
      </div>
      <div className={isCollapsed ? styles.bodyCollapsed : styles.body}>
        {children}
      </div>
    </div>
  )
}
