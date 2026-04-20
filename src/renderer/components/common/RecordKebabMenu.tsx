import { useState, useCallback } from 'react'
import { MoreHorizontal } from 'lucide-react'
import styles from './RecordKebabMenu.module.css'

export interface KebabMenuItem {
  label: string
  /** Optional icon rendered before the label */
  icon?: string
  onClick: () => void
  destructive?: boolean
}

interface RecordKebabMenuProps {
  /** Menu items grouped by section. Groups are separated by dividers. */
  groups: KebabMenuItem[][]
}

/**
 * Three-dot dropdown menu for record-level actions.
 * Takes record-type-agnostic props (action callbacks) so it's reusable
 * for Company Detail, Contact Detail, or any record type.
 */
export function RecordKebabMenu({ groups }: RecordKebabMenuProps) {
  const [open, setOpen] = useState(false)

  const handleItemClick = useCallback((onClick: () => void) => {
    setOpen(false)
    onClick()
  }, [])

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        title="More actions"
      >
        <MoreHorizontal size={14} strokeWidth={1.6} />
      </button>

      {open && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.menu}>
            {groups.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div className={styles.divider} />}
                {group.map((item, ii) => (
                  <button
                    key={ii}
                    className={`${styles.item} ${item.destructive ? styles.itemDestructive : ''}`}
                    onClick={() => handleItemClick(item.onClick)}
                  >
                    {item.icon && <span>{item.icon}</span>}
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
