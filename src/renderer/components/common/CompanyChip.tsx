/**
 * CompanyChip — pill-shaped chip rendering a company with optional favicon,
 * clickable name, and remove button. Shared across InvestorChipsCell and
 * MultiCompanyPicker.
 *
 * Visual states:
 *   - default:    solid background, name underlines on hover, X visible if !readOnly
 *   - pending:    muted background, no nav, no remove (used during async find-or-create)
 *   - readOnly:   no X, name still navigates
 *   - draggable:  shows ⋮⋮ handle on the left; HTML5 native drag events surface up via callbacks
 */
import { useRef, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { CompanyFavicon } from './CompanyFavicon'
import styles from './CompanyChip.module.css'

interface CompanyChipProps {
  id: string
  name: string
  domain?: string | null
  pending?: boolean
  readOnly?: boolean
  onClickName?: (id: string) => void
  onRemove?: (id: string) => void
  /** Stable test id for component tests. */
  testId?: string
  // ── Drag-reorder support ────────────────────────────────────────────────
  /** Enable HTML5 native drag handle. When true, the chip becomes draggable from the ⋮⋮ handle. */
  draggable?: boolean
  /** Called when drag starts; pass the index back via onDragStart. */
  onDragStart?: (id: string) => void
  /** Called while dragging over this chip — for drop-target highlight. */
  onDragOver?: (id: string) => void
  /** Called on drop onto this chip; the dragged id is in the dataTransfer. */
  onDrop?: (draggedId: string, targetId: string) => void
  /** Called when drag ends, regardless of success. */
  onDragEnd?: () => void
  /** Visual state flags. */
  isDragging?: boolean
  isDropTarget?: boolean
  /** Optional badge rendered to the right of the name (e.g. "↑ 3 more"). */
  badge?: ReactNode
  /** Tooltip for the badge. */
  badgeTitle?: string
}

export function CompanyChip({
  id,
  name,
  domain,
  pending = false,
  readOnly = false,
  onClickName,
  onRemove,
  testId,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging = false,
  isDropTarget = false,
  badge,
  badgeTitle,
}: CompanyChipProps) {
  const handleRef = useRef<HTMLSpanElement | null>(null)

  const handleNameClick = (e: MouseEvent) => {
    if (pending || !onClickName) return
    e.stopPropagation()
    onClickName(id)
  }

  const handleRemoveClick = (e: MouseEvent) => {
    e.stopPropagation()
    onRemove?.(id)
  }

  const handleDragStart = (e: DragEvent<HTMLSpanElement>) => {
    if (!draggable) return
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
    onDragStart?.(id)
  }

  const handleDragOver = (e: DragEvent<HTMLSpanElement>) => {
    if (!draggable) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    onDragOver?.(id)
  }

  const handleDrop = (e: DragEvent<HTMLSpanElement>) => {
    if (!draggable) return
    e.preventDefault()
    const draggedId = e.dataTransfer.getData('text/plain')
    if (draggedId && draggedId !== id) {
      onDrop?.(draggedId, id)
    }
  }

  const handleDragEnd = () => {
    if (!draggable) return
    onDragEnd?.()
  }

  const className = [
    styles.chip,
    pending && styles.pending,
    draggable && styles.draggable,
    isDragging && styles.dragging,
    isDropTarget && styles.dropTarget,
  ].filter(Boolean).join(' ')

  // The chip element itself is the drag source (so the whole chip moves visually).
  // The handle inside provides the affordance and is the only thing with grab cursor.
  return (
    <span
      className={className}
      data-testid={testId}
      draggable={draggable && !pending}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
    >
      {draggable && !pending && (
        <span ref={handleRef} className={styles.dragHandle} aria-label="Drag to reorder" title="Drag to reorder">
          ⋮⋮
        </span>
      )}
      {domain && <CompanyFavicon domain={domain} size={12} className={styles.favicon} />}
      <button
        type="button"
        className={styles.name}
        onClick={handleNameClick}
        disabled={pending || !onClickName}
        title={onClickName ? `Open ${name}` : name}
      >
        {name}
      </button>
      {badge && (
        <span className={styles.badge} title={badgeTitle}>
          {badge}
        </span>
      )}
      {!readOnly && !pending && onRemove && (
        <button
          type="button"
          className={styles.remove}
          onClick={handleRemoveClick}
          title="Remove"
          aria-label={`Remove ${name}`}
        >
          ×
        </button>
      )}
    </span>
  )
}
