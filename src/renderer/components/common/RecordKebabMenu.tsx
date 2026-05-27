import { useReducer, useCallback } from 'react'
import { MoreHorizontal } from 'lucide-react'
import styles from './RecordKebabMenu.module.css'

export interface KebabMenuItem {
  label: string
  /** Optional icon rendered before the label */
  icon?: string
  onClick?: () => void
  destructive?: boolean
  /** If present, clicking the item opens a one-level submenu instead of running onClick. */
  submenu?: KebabMenuItem[]
}

interface RecordKebabMenuProps {
  /** Menu items grouped by section. Groups are separated by dividers. */
  groups: KebabMenuItem[][]
}

/**
 * Three-dot dropdown menu for record-level actions.
 * Takes record-type-agnostic props (action callbacks) so it's reusable
 * for Company Detail, Contact Detail, Meeting Detail, etc.
 *
 * Supports one-level submenu drill-down via the `submenu` field on an item:
 *
 *   ROOT ──click item.submenu──▶ SUBMENU
 *     ▲                            │
 *     └───── Back / backdrop ──────┘
 */

export type KebabState = {
  open: boolean
  submenu: KebabMenuItem[] | null
}

export type KebabAction =
  | { type: 'TOGGLE' }
  | { type: 'OPEN_SUBMENU'; submenu: KebabMenuItem[] }
  | { type: 'BACK' }
  | { type: 'CLOSE' }

export const initialKebabState: KebabState = { open: false, submenu: null }

export function kebabReducer(state: KebabState, action: KebabAction): KebabState {
  switch (action.type) {
    case 'TOGGLE':
      return state.open ? { open: false, submenu: null } : { open: true, submenu: null }
    case 'OPEN_SUBMENU':
      return { open: true, submenu: action.submenu }
    case 'BACK':
      return { open: true, submenu: null }
    case 'CLOSE':
      return { open: false, submenu: null }
  }
}

export function RecordKebabMenu({ groups }: RecordKebabMenuProps) {
  const [state, dispatch] = useReducer(kebabReducer, initialKebabState)

  const handleItemClick = useCallback((item: KebabMenuItem) => {
    if (item.submenu) {
      dispatch({ type: 'OPEN_SUBMENU', submenu: item.submenu })
      return
    }
    dispatch({ type: 'CLOSE' })
    item.onClick?.()
  }, [])

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.trigger}
        onClick={() => dispatch({ type: 'TOGGLE' })}
        title="More actions"
      >
        <MoreHorizontal size={14} strokeWidth={1.6} />
      </button>

      {state.open && (
        <>
          <div className={styles.backdrop} onClick={() => dispatch({ type: 'CLOSE' })} />
          <div className={styles.menu}>
            {state.submenu ? (
              <>
                <button
                  className={`${styles.item} ${styles.backRow}`}
                  onClick={() => dispatch({ type: 'BACK' })}
                >
                  <span>‹</span>
                  Back
                </button>
                <div className={styles.divider} />
                {state.submenu.map((item, ii) => (
                  <button
                    key={ii}
                    className={`${styles.item} ${item.destructive ? styles.itemDestructive : ''}`}
                    onClick={() => handleItemClick(item)}
                  >
                    {item.icon && <span>{item.icon}</span>}
                    {item.label}
                  </button>
                ))}
              </>
            ) : (
              groups.map((group, gi) => (
                <div key={gi}>
                  {gi > 0 && <div className={styles.divider} />}
                  {group.map((item, ii) => (
                    <button
                      key={ii}
                      className={`${styles.item} ${item.destructive ? styles.itemDestructive : ''} ${item.submenu ? styles.itemWithSubmenu : ''}`}
                      onClick={() => handleItemClick(item)}
                    >
                      {item.icon && <span>{item.icon}</span>}
                      <span className={styles.itemLabel}>{item.label}</span>
                      {item.submenu && <span className={styles.submenuChevron}>›</span>}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
