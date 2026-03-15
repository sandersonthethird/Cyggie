/**
 * EditableCell — display/edit/saving/error state machine for a single table cell.
 *
 * State machine:
 *   DISPLAY ──click──▶ EDIT ──blur/Enter──▶ SAVING ──success──▶ DISPLAY
 *                        │                      │
 *                     Escape                  error──▶ ERROR (revert + 3s) ──▶ DISPLAY
 *
 * Props:
 *   value       — current display value (string, number, null)
 *   field       — CompanySummary field key being edited
 *   type        — 'text' | 'select' | 'number' | 'date' | 'computed'
 *   options     — for select type
 *   onSave      — async callback: (newValue: string | null) => void
 *   isFocused   — externally driven focus (keyboard nav)
 *   onFocused   — notify parent this cell is being edited
 *   onBlurEdit  — notify parent edit ended (keyboard nav)
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { daysSince, formatLastTouch } from '../../utils/format'
import type { ColumnDef } from './companyColumns'
import styles from './EditableCell.module.css'

type CellState = 'display' | 'edit' | 'saving' | 'error'

interface EditableCellProps {
  value: unknown
  col: ColumnDef
  onSave: (newValue: string | null) => Promise<void>
  isFocused: boolean
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

  if (value == null || value === '') {
    return <span className={styles.cellEmpty}>—</span>
  }

  return <span className={styles.cellText}>{String(value)}</span>
}

function EditableCellInner({
  value,
  col,
  onSave,
  isFocused,
  onStartEdit,
  onEndEdit
}: EditableCellProps) {
  const [cellState, setCellState] = useState<CellState>('display')
  const [draft, setDraft] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const savedValueRef = useRef<unknown>(value)

  // Keep savedValueRef in sync with prop (reflects optimistic patches from parent)
  savedValueRef.current = value

  // If parent requests focus (keyboard nav), enter edit mode
  useEffect(() => {
    if (isFocused && col.editable && cellState === 'display') {
      startEdit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused])

  // Focus the input when entering edit mode
  useEffect(() => {
    if (cellState === 'edit' && inputRef.current) {
      inputRef.current.focus()
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select()
      }
    }
  }, [cellState])

  const startEdit = useCallback(() => {
    if (!col.editable) return
    const current = savedValueRef.current
    setDraft(current == null ? '' : String(current))
    setCellState('edit')
    onStartEdit()
  }, [col.editable, onStartEdit])

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

  function handleClick() {
    if (cellState === 'display') startEdit()
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

  return (
    <div
      className={styles.cell}
      onClick={handleClick}
      role={col.editable ? 'button' : undefined}
      tabIndex={col.editable ? 0 : undefined}
      onKeyDown={col.editable && cellState === 'display' ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit() } } : handleKeyDown}
    >
      {errorMsg && <span className={styles.errorMsg}>{errorMsg}</span>}

      {cellState === 'edit' && col.type === 'select' ? (
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          className={styles.editSelect}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        >
          {col.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
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
