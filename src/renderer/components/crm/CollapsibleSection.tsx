import { useMemo, type ReactNode, type MouseEvent } from 'react'
import styles from './CollapsibleSection.module.css'

interface CollapsibleSectionProps {
  title: string
  /** Number of visible non-empty fields. Drives the count pill / "empty" label / auto-collapse. */
  count: number
  /** Saved collapse state from useSectionCollapse. */
  isCollapsed: boolean
  onToggle: () => void
  /** Whether the user has explicitly toggled this section (suppresses auto-collapse-when-empty). */
  hasUserToggled?: boolean
  /** Per-section "+ Add" affordance. Stops propagation so the header doesn't toggle. */
  onAdd?: () => void
  children: ReactNode
}

/**
 * Variant C section: clickable header (chevron / title / count pill / hover-revealed +Add)
 * + collapsible body. Smooth body height transition via the grid-template-rows trick.
 *
 * Auto-collapse: when count === 0 and the user hasn't manually toggled, the section
 * defaults to collapsed without writing to prefs. The pill shows "empty" instead of "0".
 */
export function CollapsibleSection({
  title,
  count,
  isCollapsed,
  onToggle,
  hasUserToggled,
  onAdd,
  children,
}: CollapsibleSectionProps) {
  // Effective collapsed = explicit collapse OR auto-collapse on empty
  const autoCollapsed = !hasUserToggled && count === 0
  const effectivelyCollapsed = isCollapsed || autoCollapsed

  const pillContent = useMemo(() => {
    if (count === 0) return <span className={styles.countEmpty}>empty</span>
    return count
  }, [count])

  function handleAddClick(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    onAdd?.()
  }

  function handleHeaderKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    }
  }

  return (
    <section className={styles.section}>
      <div
        className={styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={!effectivelyCollapsed}
        onClick={onToggle}
        onKeyDown={handleHeaderKey}
      >
        <svg
          className={styles.chevron}
          data-collapsed={effectivelyCollapsed}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className={styles.title}>{title}</span>
        <span className={styles.count} data-empty={count === 0}>{pillContent}</span>
        {onAdd && (
          <button
            type="button"
            className={styles.addBtn}
            onClick={handleAddClick}
            title={`Add field to ${title}`}
            aria-label={`Add field to ${title}`}
          >
            + Add
          </button>
        )}
      </div>
      <div className={styles.body} data-collapsed={effectivelyCollapsed} aria-hidden={effectivelyCollapsed}>
        <div className={styles.bodyInner}>{children}</div>
      </div>
    </section>
  )
}
