/**
 * EditableCell — display/focus/edit/saving/error state machine for a single table cell.
 *
 * State machine:
 *   DISPLAY ──click──▶ FOCUSED (highlight, no input)
 *   FOCUSED ──dbl-click/Enter──▶ EDIT ──blur/Enter──▶ SAVING ──success──▶ DISPLAY
 *                                  │   │                 │
 *                                Esc   picks sentinel   error──▶ ERROR (revert + 3s) ──▶ DISPLAY
 *                                  │   │
 *                                  │   ▼
 *                                  │  ADDING_OPTION ──Enter (non-empty)──▶ [addCustomFieldOption + onSave] ──▶ DISPLAY
 *                                  │        │
 *                                  └─ Esc/blur ──▶ FOCUSED (stay focused after cancel)
 *
 * Props:
 *   value         — current display value (string, number, null)
 *   col           — ColumnDef for the field being displayed/edited
 *   isHighlighted — externally driven focus highlight (single-click, arrow nav, range selection)
 *   isEditing     — externally driven edit mode (double-click, Enter, type-to-edit)
 *   initialChar   — if set, seeds draft with this char instead of current value (type-to-edit)
 *   onSave        — async callback: (newValue: string | null) => void
 *   onFocus       — notify parent this cell is focused (single click)
 *   onStartEdit   — notify parent this cell is being edited (double click)
 *   onEndEdit     — notify parent edit ended (keyboard nav)
 */
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { daysSince, formatLastTouch } from '../../utils/format'
import { AddOptionInlineInput } from '../crm/AddOptionInlineInput'
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
  onFocus: (shiftKey?: boolean) => void
  onStartEdit: () => void
  onEndEdit: (advanceDir?: 'down' | 'right' | null) => void
}

function renderBadge(col: ColumnDef, value: unknown): React.ReactNode {
  if (!value) return <span className={styles.cellEmpty}>—</span>
  const str = String(value)
  if (col.key === 'pipelineStage') {
    const cls = `stage-${str}` as keyof typeof styles
    return <span className={`${styles.badge} ${styles[cls] ?? ''}`}>{col.options?.find(o => o.value === str)?.label ?? str}</span>
  }
  if (col.key === 'entityType') {
    const cls = `type-${str}` as keyof typeof styles
    return <span className={`${styles.badge} ${styles[cls] ?? ''}`}>{col.options?.find(o => o.value === str)?.label ?? str}</span>
  }
  if (col.key === 'priority') {
    const cls = `priority-${str}` as keyof typeof styles
    return <span className={`${styles.badge} ${styles[cls] ?? ''}`}>{col.options?.find(o => o.value === str)?.label ?? str}</span>
  }
  if (col.key === 'contactType') {
    const cls = `contactType-${str}` as keyof typeof styles
    return <span className={`${styles.badge} ${styles[cls] ?? ''}`}>{col.options?.find(o => o.value === str)?.label ?? str}</span>
  }
  return null
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
  onFocus,
  onStartEdit,
  onEndEdit
}: EditableCellProps) {
  const [cellState, setCellState] = useState<CellState>('display')
  const [draft, setDraft] = useState('')
  const [addingOption, setAddingOption] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const savedValueRef = useRef<unknown>(value)

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
  useLayoutEffect(() => {
    if (cellState === 'edit' && inputRef.current) {
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

  const commitEdit = useCallback(async (advanceDir: 'down' | 'right' | null) => {
    const original = savedValueRef.current
    const trimmed = draft.trim()
    const newVal = trimmed === '' ? null : trimmed
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
    if (cellState === 'display') {
      onFocus(e.shiftKey)
    }
  }

  function handleDoubleClick() {
    if (cellState === 'display' || (cellState === 'display' && isHighlighted)) {
      startEdit()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (cellState !== 'edit') return
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

  return (
    <div
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

      {cellState === 'edit' && col.type === 'select' && addingOption ? (
        <AddOptionInlineInput
          className={styles.editInput}
          onConfirm={async (opt) => {
            setAddingOption(false)
            try {
              await onAddOption?.(opt)
              await onSave(opt)
            } catch (e) {
              console.error('[EditableCell] addOption failed:', e)
            }
            cancelEdit()
          }}
          onCancel={() => { setAddingOption(false); cancelEdit() }}
        />
      ) : cellState === 'edit' && col.type === 'select' ? (
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          className={styles.editSelect}
          value={draft}
          onChange={(e) => {
            if (e.target.value === '__add_option__') {
              setAddingOption(true)
              return
            }
            setDraft(e.target.value)
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        >
          {col.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {onAddOption && (
            <option value="__add_option__">+ Add option...</option>
          )}
        </select>
      ) : cellState === 'edit' ? (
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
        renderDisplay(col, value)
      )}
    </div>
  )
}

export const EditableCell = memo(EditableCellInner)
