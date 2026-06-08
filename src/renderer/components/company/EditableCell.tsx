/**
 * EditableCell — display/focus/edit/saving/error state machine for a single table cell.
 *
 * State machine:
 *   DISPLAY ──click──▶ FOCUSED (highlight, no input)
 *   FOCUSED ──dbl-click/Enter──▶ EDIT ──blur/Enter──▶ SAVING ──success──▶ DISPLAY
 *                                  │   │                 │
 *                                Esc   picks sentinel   error──▶ ERROR (revert + 3s) ──▶ DISPLAY
 *                                  │
 *                                  └─ Esc ──▶ FOCUSED (stay focused after cancel)
 *
 *   Dropdown cells (col.type === 'select') use a three-click flow:
 *     DISPLAY ──click──▶ FOCUSED ──click(same cell)──▶ EDIT (popover opens)
 *                                                       │
 *                                                       ├─ pick option ─▶ commitEdit(advanceDir=null, value)
 *                                                       │                  └─ explicit value bypasses
 *                                                       │                     stale-closure on `draft`
 *                                                       └─ Esc/outside-click ─▶ FOCUSED
 *
 *   Unmount cleanup (virtualized scroll-out):
 *     A cell that unmounts while in EDIT calls onEndEdit(null) so the parent
 *     hook clears editCell. Prevents the popover from re-opening on remount
 *     and stops getBoundingClientRect on a dead anchor.
 *
 * Props:
 *   value           — current display value (string, number, null)
 *   col             — ColumnDef for the field being displayed/edited
 *   rangePosition   — externally driven focus highlight position ('only' = single focused cell)
 *   isEditing       — externally driven edit mode (double-click, Enter, type-to-edit)
 *   initialChar     — if set, seeds draft with this char instead of current value (type-to-edit)
 *   scrollContainer — table scroll container; passed through to OptionListPopover for reposition
 *   onSave          — async callback: (newValue: string | null) => void
 *   onFocus         — notify parent this cell is focused (single click)
 *   onStartEdit     — notify parent this cell is being edited (double click or 2nd click on select)
 *   onEndEdit       — notify parent edit ended (keyboard nav)
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { daysSince, formatLastTouch } from '../../utils/format'
import { chipStyle } from '../../utils/colorChip'
import { OptionListPopover } from '../crm/OptionListPopover'
import type { ColumnDef } from './companyColumns'
import styles from './EditableCell.module.css'

type CellState = 'display' | 'edit' | 'saving' | 'error'

/** Position within a contiguous range selection. null = not highlighted. */
export type RangePosition = 'only' | 'top' | 'mid' | 'bot' | null

interface EditableCellProps {
  value: unknown
  col: ColumnDef
  onSave: (newValue: string | null) => Promise<void>
  onAddOption?: (newOption: string) => Promise<void>
  /** Cell highlight position. null=none, 'only'=single cell, 'top'/'mid'/'bot'=range position. */
  rangePosition: RangePosition
  isEditing: boolean
  initialChar?: string
  /** Table scroll container; passed to OptionListPopover so it can reposition on scroll. */
  scrollContainer?: HTMLElement | null
  onFocus: (shiftKey?: boolean) => void
  onStartEdit: () => void
  onEndEdit: (advanceDir?: 'down' | 'right' | null) => void
}

const BADGE_ATTR_BY_COLUMN: Record<string, string> = {
  pipelineStage: 'data-stage',
  entityType:    'data-entity-type',
  priority:      'data-priority',
  contactType:   'data-contact-type',
}

function renderBadge(col: ColumnDef, value: unknown): React.ReactNode {
  if (!value) return <span className={styles.cellEmpty}>—</span>
  const str = String(value)
  const attr = BADGE_ATTR_BY_COLUMN[col.key]
  if (!attr) return null
  const label = col.options?.find(o => o.value === str)?.label ?? str
  return <span className={styles.badge} {...{ [attr]: str }}>{label}</span>
}

function renderDisplay(col: ColumnDef, value: unknown): React.ReactNode {
  if (col.key === 'lastTouchpoint') {
    const label = formatLastTouch(value as string | null)
    if (!label) return <span className={styles.cellEmpty}>—</span>
    const d = daysSince(value as string | null)
    const dotClass =
      d == null ? styles.warmthGray
      : d < 14   ? styles.warmthGreen
      : d <= 30  ? styles.warmthYellow
      :             styles.warmthRed
    return (
      <span className={styles.warmthCell}>
        <span className={`${styles.warmthDot} ${dotClass}`} />
        <span className={styles.cellText}>{label}</span>
      </span>
    )
  }

  if (col.key === 'pipelineStage' || col.key === 'entityType' || col.key === 'priority' || col.key === 'contactType') {
    return renderBadge(col, value)
  }

  if (col.type === 'select' && value) {
    const label = col.options?.find((o) => o.value === String(value))?.label ?? String(value)
    return <span className={styles.cellText}>{label}</span>
  }

  // Number/currency formatting — applies to all columns with prefix/suffix or number type
  if ((col.type === 'number' || col.prefix || col.suffix) && value != null && value !== '') {
    const num = parseFloat(String(value))
    if (!isNaN(num)) {
      // Group with thousands separators on currency columns and any column with explicit
      // numeric formatting; skip for plain integers like founding year.
      const useGrouping = col.prefix === '$' || col.decimals != null || col.sigDigits != null
      let formatted: string
      if (col.sigDigits != null) {
        // Round to N sig figs, then format. Round-trip via Number drops toPrecision's
        // trailing zeros and scientific notation (e.g. 12.5 → '13', 0.85 → '0.85').
        const rounded = Number(num.toPrecision(col.sigDigits))
        formatted = rounded.toLocaleString('en-US', { useGrouping, maximumFractionDigits: 20 })
      } else if (col.decimals != null) {
        formatted = num.toLocaleString('en-US', {
          useGrouping,
          minimumFractionDigits: col.decimals,
          maximumFractionDigits: col.decimals
        })
      } else {
        formatted = num.toLocaleString('en-US', { useGrouping, maximumFractionDigits: 20 })
      }
      return <span className={styles.cellText}>{col.prefix ?? ''}{formatted}{col.suffix ?? ''}</span>
    }
  }

  if (value == null || value === '') {
    return <span className={styles.cellEmpty}>—</span>
  }

  return <span className={styles.cellText}>{String(value)}</span>
}

function EditableCellInner({
  value,
  col,
  onSave,
  onAddOption,
  rangePosition,
  isEditing,
  initialChar,
  scrollContainer,
  onFocus,
  onStartEdit,
  onEndEdit
}: EditableCellProps) {
  const [cellState, setCellState] = useState<CellState>('display')
  const [draft, setDraft] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const cellRootRef = useRef<HTMLDivElement>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savedValueRef = useRef<unknown>(value)
  // Mirror cellState so the unmount cleanup can read the final value without
  // adding it as a dep (which would re-fire the cleanup on every state change).
  const cellStateRef = useRef<CellState>('display')
  cellStateRef.current = cellState

  // Keep savedValueRef in sync with prop (reflects optimistic patches from parent)
  savedValueRef.current = value

  // If parent requests edit (keyboard nav / double-click), enter edit mode
  useEffect(() => {
    if (isEditing && col.editable && cellState === 'display') {
      startEdit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  // Focus the input when entering edit mode.
  // useLayoutEffect (not useEffect) so focus happens synchronously after the
  // input mounts, before paint — closes the race where a fast typist's first
  // keystroke after a double-click landed before the input was focused.
  //
  // For type-to-edit (initialChar set), place the cursor at the end so the
  // next typed character appends instead of replacing the seed character.
  // For click/Enter-to-edit, select() so typing replaces existing text — the
  // long-standing behavior.
  //
  // Skipped for select cells — OptionListPopover owns its own focus.
  useLayoutEffect(() => {
    if (cellState === 'edit' && col.type !== 'select' && inputRef.current) {
      inputRef.current.focus()
      if (inputRef.current instanceof HTMLInputElement) {
        if (initialChar) {
          const len = inputRef.current.value.length
          inputRef.current.setSelectionRange(len, len)
        } else {
          inputRef.current.select()
        }
      }
    }
    // initialChar intentionally omitted from deps: it is captured at the moment
    // we transition into edit, and any later prop change shouldn't re-fire focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellState])

  // Unmount cleanup: if a select cell is unmounted while its popover is open
  // (TanStack Virtual scroll-out, route change, parent rerender that drops
  // the row), clear editCell in the parent hook so we don't dangle a popover
  // anchored to a dead DOM node.
  useEffect(() => {
    return () => {
      if (cellStateRef.current === 'edit') {
        onEndEdit(null)
      }
    }
    // Bind onEndEdit by identity at mount; later changes shouldn't re-fire cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startEdit = useCallback(() => {
    if (!col.editable) return
    if (initialChar) {
      setDraft(initialChar)
    } else {
      const current = savedValueRef.current
      setDraft(current == null ? '' : String(current))
    }
    setCellState('edit')
    onStartEdit()
  }, [col.editable, initialChar, onStartEdit])

  const cancelEdit = useCallback(() => {
    setCellState('display')
    onEndEdit(null)
  }, [onEndEdit])

  /**
   * Commit the cell's draft (or an explicit value override) to onSave.
   *
   * The `valueOverride` parameter exists for the OptionListPopover pick path:
   * when the user clicks an option, we have the value in hand — we should NOT
   * rely on setDraft → re-render → next render's commitEdit closure, because
   * `setDraft` is async and the click handler runs commitEdit immediately on
   * the same render (with the stale `draft`). Passing the value explicitly
   * sidesteps the stale-closure bug entirely.
   *
   * Keyboard/blur paths (text input) continue to omit the override and read
   * from `draft` — that's correct because draft was just updated by the
   * input's controlled onChange handler.
   */
  const commitEdit = useCallback(async (
    advanceDir: 'down' | 'right' | null,
    valueOverride?: string | null,
  ) => {
    const original = savedValueRef.current
    const newVal: string | null = valueOverride !== undefined
      ? (valueOverride === '' ? null : valueOverride)
      : (() => {
          const trimmed = draft.trim()
          return trimmed === '' ? null : trimmed
        })()
    const origStr = original == null ? null : String(original)

    // No change — skip IPC
    if (newVal === origStr) {
      setCellState('display')
      onEndEdit(advanceDir)
      return
    }

    // Optimistically show DISPLAY, let parent patch
    setCellState('display')
    onEndEdit(advanceDir)

    try {
      await onSave(newVal)
    } catch {
      // Revert display by showing error — parent will not have patched if it throws
      clearTimeout(errorTimerRef.current)
      setErrorMsg('Save failed')
      setCellState('error')
      errorTimerRef.current = setTimeout(() => {
        setCellState('display')
        setErrorMsg('')
      }, 3000)
    }
  }, [draft, onSave, onEndEdit])

  function handleClick(e: React.MouseEvent) {
    if (cellState !== 'display') return
    // Three-click flow for select cells: a click on the already-focused cell
    // enters edit mode (popover opens). Other cell types stick with the
    // legacy single-click=focus, double-click=edit pattern.
    if (
      col.editable &&
      col.type === 'select' &&
      rangePosition === 'only' &&
      !e.shiftKey
    ) {
      startEdit()
      return
    }
    onFocus(e.shiftKey)
  }

  function handleDoubleClick() {
    if (cellState === 'display') {
      startEdit()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (cellState !== 'edit') return
    // Popover owns Enter/Tab/Esc/Arrow for select cells.
    if (col.type === 'select') return
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commitEdit('down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      void commitEdit('right')
    }
  }

  function handleBlur() {
    if (cellState === 'edit') {
      void commitEdit(null)
    }
  }

  const rangeClass =
    rangePosition && cellState === 'display'
      ? rangePosition === 'only' ? styles.focusedCell
        : rangePosition === 'top' ? styles.rangeTop
        : rangePosition === 'mid' ? styles.rangeMid
        : rangePosition === 'bot' ? styles.rangeBot
        : ''
      : ''

  const cellClassName = [styles.cell, rangeClass].filter(Boolean).join(' ')

  const isSelectEditing = cellState === 'edit' && col.type === 'select'

  return (
    <div
      ref={cellRootRef}
      className={cellClassName}
      onClick={handleClick}
      onDoubleClick={col.editable ? handleDoubleClick : undefined}
      role={col.editable ? 'button' : undefined}
      tabIndex={col.editable ? 0 : undefined}
      onKeyDown={col.editable && cellState === 'display' ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          startEdit()
        }
      } : handleKeyDown}
    >
      {errorMsg && <span className={styles.errorMsg}>{errorMsg}</span>}

      {cellState === 'edit' && col.type !== 'select' ? (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          className={styles.editInput}
          type={col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />
      ) : (
        // Always render the display chip/text for select cells, even while
        // editing — the popover floats above as a portal, so the chip stays
        // visible underneath for visual continuity.
        renderDisplay(col, value)
      )}

      {isSelectEditing && (
        <OptionListPopover
          anchorEl={cellRootRef.current}
          options={col.options ?? []}
          value={draft}
          mode="single"
          onPick={(v) => { void commitEdit(null, v) }}
          onPickAndAdvance={(v, dir) => { void commitEdit(dir, v) }}
          onAddOption={onAddOption ? () => { /* popover owns the inline-input swap internally */ } : undefined}
          onAddOptionConfirm={async (opt) => {
            try {
              await onAddOption?.(opt)
              await commitEdit(null, opt)
            } catch (e) {
              console.error('[EditableCell] addOption failed:', e)
              cancelEdit()
            }
          }}
          onClose={cancelEdit}
          scrollContainer={scrollContainer}
          initialChar={initialChar}
          chipStyle={chipStyle}
        />
      )}
    </div>
  )
}

export const EditableCell = memo(EditableCellInner)
