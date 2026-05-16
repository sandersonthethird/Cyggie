/**
 * MergePicker — shared first-step merge picker overlay for both contact and
 * company merge flows. Replaces near-identical inline JSX in
 * ContactModalsCollection and CompanyModalsCollection.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Merge "Acme Corp" into:                                     │
 *   │  ┌────────────────────────────────────────────────────────┐  │
 *   │  │ Search companies…                                      │  │
 *   │  └────────────────────────────────────────────────────────┘  │
 *   │  • Acme Holdings                                             │
 *   │  • Acme Industries                                           │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Caller composes search/state; this component is presentational.
 */

import styles from './atoms.module.css'

export interface MergePickerTarget {
  id: string
  name: string
}

interface MergePickerProps {
  open: boolean
  onClose: () => void
  /** Used for placeholder + empty-state text ("Search contacts…" / "No companies found"). */
  entityNoun: 'contact' | 'company'
  /** Used in the header: "Merge \"X\" into:". */
  currentEntityName: string
  query: string
  onQueryChange: (q: string) => void
  results: MergePickerTarget[]
  onSelect: (target: MergePickerTarget) => void
}

export function MergePicker({
  open,
  onClose,
  entityNoun,
  currentEntityName,
  query,
  onQueryChange,
  results,
  onSelect,
}: MergePickerProps) {
  if (!open) return null

  const placeholder = entityNoun === 'contact' ? 'Search contacts…' : 'Search companies…'
  const emptyText = query
    ? (entityNoun === 'contact' ? 'No contacts found' : 'No companies found')
    : 'Start typing to search…'

  return (
    <div className={styles.mergePickerOverlay} onClick={onClose}>
      <div className={styles.mergePicker} onClick={e => e.stopPropagation()}>
        <p className={styles.mergePickerTitle}>
          Merge &ldquo;{currentEntityName}&rdquo; into:
        </p>
        <input
          autoFocus
          className={styles.mergePickerInput}
          placeholder={placeholder}
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && onClose()}
        />
        <div className={styles.mergePickerList}>
          {results.map(r => (
            <button
              key={r.id}
              className={styles.mergePickerOption}
              onClick={() => onSelect(r)}
            >
              {r.name}
            </button>
          ))}
          {results.length === 0 && (
            <span className={styles.mergePickerEmpty}>{emptyText}</span>
          )}
        </div>
      </div>
    </div>
  )
}
