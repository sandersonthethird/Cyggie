/**
 * RangeFilter — per-column filter for 'number' and 'date' column types.
 *
 * Operator ↔ URL state mapping:
 *   gte (≥)     → { min: val }
 *   lte (≤)     → { max: val }
 *   eq  (=)     → { min: val, max: val }
 *   between (↔) → { min: val1, max: val2 }
 *
 * Operator is local UI state — only min/max persist in the URL (via parent).
 * On re-open the operator is reconstructed from the current range:
 *   min && max && min === max → 'eq'
 *   min && max               → 'between'
 *   min only                 → 'gte'
 *   max only                 → 'lte'
 *   neither                  → 'gte' (default)
 *
 * Auto-swap: when operator='between' and val1 > val2 on blur, values are silently swapped
 * before calling onChange. The needsSwap helper is exported for unit testing.
 */
import { useEffect, useRef, useState } from 'react'
import type { RangeValue } from './tableUtils'
import styles from './RangeFilter.module.css'

type Operator = 'gte' | 'lte' | 'eq' | 'between'

export interface RangeFilterProps {
  colType: 'number' | 'date'
  range: RangeValue
  onChange: (range: RangeValue) => void
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  label: string
  prefix?: string
  suffix?: string
}

/** Exported for unit testing. Returns true if val1 and val2 are both non-empty and val1 > val2. */
export function needsSwap(val1: string, val2: string, colType: 'number' | 'date'): boolean {
  if (!val1 || !val2) return false
  return colType === 'number' ? Number(val1) > Number(val2) : val1 > val2
}

function deriveOperator(range: RangeValue): Operator {
  const { min, max } = range
  const hasMin = min != null && min !== ''
  const hasMax = max != null && max !== ''
  if (hasMin && hasMax && min === max) return 'eq'
  if (hasMin && hasMax) return 'between'
  if (hasMin) return 'gte'
  if (hasMax) return 'lte'
  return 'gte'
}

const OPERATOR_LABELS: Record<Operator, string> = {
  gte: '≥ at least',
  lte: '≤ at most',
  eq: '= equals',
  between: '↔ between'
}

export function RangeFilter({
  colType,
  range,
  onChange,
  isOpen,
  onOpen,
  onClose,
  label,
  prefix = '',
  suffix = ''
}: RangeFilterProps) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [operator, setOperator] = useState<Operator>(() => deriveOperator(range))
  const [val1, setVal1] = useState(range.min ?? range.max ?? '')
  const [val2, setVal2] = useState(range.max ?? '')

  // When the dropdown opens, re-derive local state from the current range prop
  useEffect(() => {
    if (!isOpen) return
    const op = deriveOperator(range)
    setOperator(op)
    if (op === 'lte') {
      setVal1(range.max ?? '')
      setVal2('')
    } else {
      setVal1(range.min ?? '')
      setVal2(range.max ?? '')
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return
    function handleMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [isOpen, onClose])

  function handleOperatorChange(op: Operator) {
    setOperator(op)
    // Reset val2 when switching away from 'between'
    if (op !== 'between') setVal2('')
  }

  function commit(v1: string, v2: string, op: Operator) {
    const swapped = op === 'between' && needsSwap(v1, v2, colType)
    const effectiveV1 = swapped ? v2 : v1
    const effectiveV2 = swapped ? v1 : v2

    if (op === 'gte')     onChange({ min: effectiveV1 || undefined })
    else if (op === 'lte') onChange({ max: effectiveV1 || undefined })
    else if (op === 'eq')  onChange({ min: effectiveV1 || undefined, max: effectiveV1 || undefined })
    else                   onChange({ min: effectiveV1 || undefined, max: effectiveV2 || undefined })
  }

  function handleVal2Blur() {
    commit(val1, val2, operator)
    if (needsSwap(val1, val2, colType)) {
      const tmp = val1; setVal1(val2); setVal2(tmp)
    }
  }

  function handleApply() {
    commit(val1, val2, operator)
    onClose()
  }

  function handleClear() {
    setVal1(''); setVal2(''); setOperator('gte')
    onChange({})
    onClose()
  }

  const isActive = (range.min != null && range.min !== '') || (range.max != null && range.max !== '')

  function formatBadge(): string {
    const { min, max } = range
    const fmt = (v: string) =>
      colType === 'date'
        ? new Date(v + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
        : `${prefix}${v}${suffix}`
    if (!min && !max) return ''
    if (min && max && min === max) return `=${fmt(min)}`
    if (min && max) return `${fmt(min)}-${fmt(max)}`
    if (min) return `≥${fmt(min)}`
    return `≤${fmt(max!)}`
  }

  const inputType = colType === 'date' ? 'date' : 'number'

  return (
    <span className={styles.wrap} ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        className={`${styles.btn} ${isActive ? styles.btnActive : ''}`}
        onClick={() => (isOpen ? onClose() : onOpen())}
        title={`Filter by ${label}`}
        type="button"
      >
        ▿{isActive && <span className={styles.badge}>{formatBadge()}</span>}
      </button>
      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.inputRow}>
            <select
              className={styles.operatorSelect}
              value={operator}
              onChange={(e) => handleOperatorChange(e.target.value as Operator)}
            >
              {(Object.entries(OPERATOR_LABELS) as [Operator, string][]).map(([op, lbl]) => (
                <option key={op} value={op}>{lbl}</option>
              ))}
            </select>
          </div>
          <div className={styles.inputRow}>
            <input
              className={styles.input}
              type={inputType}
              step={colType === 'number' ? 'any' : undefined}
              placeholder={operator === 'lte' ? 'max' : 'min'}
              value={val1}
              onChange={(e) => setVal1(e.target.value)}
              onBlur={() => operator !== 'between' && commit(val1, val2, operator)}
              onKeyDown={(e) => e.key === 'Enter' && handleApply()}
              autoFocus
            />
          </div>
          {operator === 'between' && (
            <>
              <div className={styles.andLabel}>and</div>
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  type={inputType}
                  step={colType === 'number' ? 'any' : undefined}
                  placeholder="max"
                  value={val2}
                  onChange={(e) => setVal2(e.target.value)}
                  onBlur={handleVal2Blur}
                  onKeyDown={(e) => e.key === 'Enter' && handleApply()}
                />
              </div>
            </>
          )}
          <div className={styles.actions}>
            <button className={styles.applyBtn} type="button" onClick={handleApply}>
              Apply
            </button>
            {isActive && (
              <button className={styles.clearBtn} type="button" onClick={handleClear}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  )
}
