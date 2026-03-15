/**
 * CompanyTable — Attio-style div-grid table for the companies list.
 *
 * Architecture:
 *   - Div-grid layout (not <table>) for TanStack Virtual + sticky column compatibility
 *   - Sticky left: checkbox col + name col
 *   - Sort state owned by parent (Companies.tsx); passed as sort/onSort props
 *   - Column visibility + widths persisted to localStorage via companyColumns.ts
 *   - visibleKeys is LIFTED to parent (Companies.tsx) so saved views can control columns
 *   - EditableCell (React.memo) handles cell state machine
 *   - Keyboard nav: Enter = down, Tab = right; boundary exits edit mode
 *
 * Data flow:
 *   parent passes filteredCompanies[] (already sorted + filtered)
 *   → CompanyTable renders virtual rows
 *   → EditableCell onSave → parent patches companies[]
 *
 * Bulk edit state machine:
 *   BulkBar visible when selectedIds.size > 0
 *     [Edit fields ▾] → bulkEditOpen → BulkEditDropdown
 *       pick field tab → pick value → Apply → executeBulkEdit (chunked, partial rollback)
 *     [Actions ▾] → Delete
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanySummary } from '../../../shared/types/company'
import { EditableCell } from './EditableCell'
import { ColumnPicker } from './ColumnPicker'
import {
  COLUMN_DEFS,
  COMPANY_HEADER_KEYS,
  ENTITY_TYPES,
  STAGES,
  PRIORITIES,
  ROUNDS,
  loadColumnWidths,
  saveColumnConfig,
  saveColumnWidths,
  type ColumnDef,
  type SortState
} from './companyColumns'
import { executeBulkEdit } from '../crm/tableUtils'
import { usePreferencesStore } from '../../stores/preferences.store'
import styles from './CompanyTable.module.css'
import { api } from '../../api'

const CHECKBOX_WIDTH = 40
const PICKER_WIDTH = 44
const ROW_HEIGHT = 38

// Fields available for bulk editing with their option sets
const BULK_EDIT_FIELDS = [
  { key: 'entityType',    label: 'Type',     options: ENTITY_TYPES },
  { key: 'pipelineStage', label: 'Stage',    options: [{ value: '', label: 'Clear' }, ...STAGES] },
  { key: 'priority',      label: 'Priority', options: [{ value: '', label: 'Clear' }, ...PRIORITIES] },
  { key: 'round',         label: 'Round',    options: [{ value: '', label: 'Clear' }, ...ROUNDS] }
] as const

type BulkFieldKey = (typeof BULK_EDIT_FIELDS)[number]['key']

interface CompanyTableProps {
  companies: CompanySummary[]
  loading: boolean
  sort: SortState
  onSort: (key: string, dir: 'asc' | 'desc') => void
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onBulkDelete: (ids: string[]) => void
  onCreateInline: (name: string) => Promise<void>
  /** Lifted from internal state — parent (Companies.tsx) owns this for saved views. */
  visibleKeys: string[]
  onVisibleKeysChange: (keys: string[]) => void
}

export function CompanyTable({
  companies,
  loading,
  sort,
  onSort,
  onPatch,
  onBulkDelete,
  onCreateInline,
  visibleKeys,
  onVisibleKeysChange
}: CompanyTableProps) {
  const navigate = useNavigate()
  const { getJSON, setJSON } = usePreferencesStore()
  const summaryKeys = getJSON<string[]>('cyggie:company-summary-fields', [])

  function toggleSummaryField(key: string) {
    const next = summaryKeys.includes(key)
      ? summaryKeys.filter((k) => k !== key)
      : [...summaryKeys, key]
    setJSON('cyggie:company-summary-fields', next)
  }

  function isPinnable(col: ColumnDef): boolean {
    return col.type !== 'computed' && col.field != null && !COMPANY_HEADER_KEYS.has(col.key)
  }

  // ── Column widths ──────────────────────────────────────────────────────────
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => loadColumnWidths())

  const visibleCols = useMemo<ColumnDef[]>(
    () => visibleKeys.flatMap((k) => COLUMN_DEFS.find((c) => c.key === k) ?? []),
    [visibleKeys]
  )

  // grid-template-columns: checkbox | name | ...rest | picker
  const gridCols = useMemo(() => {
    const cols = visibleCols.map((c) => `${colWidths[c.key] ?? c.width}px`)
    return `${CHECKBOX_WIDTH}px ${cols.join(' ')} ${PICKER_WIDTH}px`
  }, [visibleCols, colWidths])

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkEditing, setBulkEditing] = useState(false)
  const [bulkEditError, setBulkEditError] = useState<string | null>(null)
  const [bulkEditField, setBulkEditField] = useState<BulkFieldKey>('entityType')
  const [bulkEditValue, setBulkEditValue] = useState<string>('')
  const bulkEditRef = useRef<HTMLDivElement>(null)
  const lastSelectedIdxRef = useRef<number | null>(null)

  useEffect(() => {
    if (!bulkEditOpen) return
    function handle(e: MouseEvent) {
      if (bulkEditRef.current && !bulkEditRef.current.contains(e.target as Node)) {
        setBulkEditOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [bulkEditOpen])

  function toggleSelect(id: string, rowIdx: number, shiftKey: boolean) {
    if (shiftKey && lastSelectedIdxRef.current !== null) {
      const lo = Math.min(lastSelectedIdxRef.current, rowIdx)
      const hi = Math.max(lastSelectedIdxRef.current, rowIdx)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) {
          const item = companies[i]
          if (item) next.add(item.id)
        }
        return next
      })
    } else {
      lastSelectedIdxRef.current = rowIdx
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0 || bulkDeleting) return
    setBulkDeleting(true)
    const ids = Array.from(selectedIds)
    setSelectedIds(new Set())
    await Promise.all(ids.map((id) => api.invoke(IPC_CHANNELS.COMPANY_DELETE, id)))
    setBulkDeleting(false)
    onBulkDelete(ids)
  }

  async function handleBulkEdit() {
    if (selectedIds.size === 0 || bulkEditing) return
    setBulkEditOpen(false)
    setBulkEditing(true)
    setBulkEditError(null)

    const ids = Array.from(selectedIds)
    const fieldValue = bulkEditValue === '' ? null : bulkEditValue

    // Capture originals BEFORE optimistic patch
    const originals = new Map(
      ids.map((id) => {
        const company = companies.find((c) => c.id === id)
        return [id, company ? (company as Record<string, unknown>)[bulkEditField] : null]
      })
    )

    // Optimistic patch
    for (const id of ids) {
      onPatch(id, { [bulkEditField]: fieldValue })
    }

    const { failedIds } = await executeBulkEdit({
      ids,
      getOriginalValue: (id) => originals.get(id) ?? null,
      updateFn: (id) =>
        api.invoke(IPC_CHANNELS.COMPANY_UPDATE, id, { [bulkEditField]: fieldValue }),
      onPatch: (id, value) => onPatch(id, { [bulkEditField]: value })
    })

    if (failedIds.length > 0) {
      setBulkEditError(`${failedIds.length} of ${ids.length} updates failed — reverted`)
    } else {
      setSelectedIds(new Set())
    }

    setBulkEditing(false)
  }

  // ── Inline edit keyboard nav ───────────────────────────────────────────────
  const [editCell, setEditCell] = useState<{ rowIdx: number; colIdx: number } | null>(null)

  function handleStartEdit(rowIdx: number, colIdx: number) {
    setEditCell({ rowIdx, colIdx })
  }

  function handleEndEdit(rowIdx: number, colIdx: number, advanceDir: 'down' | 'right' | null) {
    setEditCell(null)
    if (!advanceDir) return

    const editableCols = visibleCols
      .map((c, i) => ({ col: c, i }))
      .filter(({ col }) => col.editable)

    if (advanceDir === 'down') {
      const nextRow = rowIdx + 1
      if (nextRow < companies.length) {
        setEditCell({ rowIdx: nextRow, colIdx })
        scrollToRow(nextRow)
      }
    } else if (advanceDir === 'right') {
      const currentEditIdx = editableCols.findIndex(({ i }) => i === colIdx)
      const nextEditable = editableCols[currentEditIdx + 1]
      if (nextEditable) {
        setEditCell({ rowIdx, colIdx: nextEditable.i })
      }
    }
  }

  // ── Column resize ──────────────────────────────────────────────────────────
  const resizeDragging = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(0)
  const resizeKey = useRef('')

  const onResizeMouseDown = useCallback((e: React.MouseEvent, colKey: string, currentW: number) => {
    e.preventDefault()
    e.stopPropagation()
    resizeDragging.current = true
    resizeStartX.current = e.clientX
    resizeStartW.current = currentW
    resizeKey.current = colKey
  }, [])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizeDragging.current) return
      const delta = e.clientX - resizeStartX.current
      const newW = Math.max(60, resizeStartW.current + delta)
      setColWidths((prev) => ({ ...prev, [resizeKey.current]: newW }))
    }
    function onMouseUp() {
      if (!resizeDragging.current) return
      resizeDragging.current = false
      setColWidths((prev) => {
        saveColumnWidths(prev)
        return prev
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // ── Sort ───────────────────────────────────────────────────────────────────
  function handleHeaderClick(col: ColumnDef) {
    if (!col.sortable) return
    const newDir = sort.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc'
    onSort(col.key, newDir)
  }

  // ── Inline save ────────────────────────────────────────────────────────────
  const handleCellSave = useCallback(
    async (company: CompanySummary, field: string, newValue: string | null) => {
      const patch: Record<string, unknown> = { [field]: newValue === '' ? null : newValue }
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, patch)
      onPatch(company.id, patch)
    },
    [onPatch]
  )

  // ── Inline add row ─────────────────────────────────────────────────────────
  const [addingRow, setAddingRow] = useState(false)
  const [addName, setAddName] = useState('')
  const addInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addingRow) addInputRef.current?.focus()
  }, [addingRow])

  async function handleAddRowSubmit() {
    const name = addName.trim()
    if (!name) { setAddingRow(false); return }
    setAddName('')
    setAddingRow(false)
    await onCreateInline(name)
  }

  // ── TanStack Virtual ───────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: companies.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6
  })

  function scrollToRow(idx: number) {
    rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
  }

  const virtualRows = rowVirtualizer.getVirtualItems()

  // Current bulk edit field options
  const currentBulkField = BULK_EDIT_FIELDS.find((f) => f.key === bulkEditField)!

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {bulkEditError && (
        <div className={styles.bulkErrorBanner}>
          {bulkEditError}
          <button onClick={() => setBulkEditError(null)}>✕</button>
        </div>
      )}

      <div className={styles.tableWrapper} ref={scrollRef}>
        {/* Header row */}
        <div className={styles.headerRow} style={{ gridTemplateColumns: gridCols }}>
          {/* Checkbox */}
          <div className={`${styles.headerCell} ${styles.checkboxCol} ${styles.checkboxCell}`}>
            <input
              type="checkbox"
              className={styles.checkboxInput}
              checked={selectedIds.size === companies.length && companies.length > 0}
              onChange={(e) => {
                lastSelectedIdxRef.current = null
                setSelectedIds(e.target.checked ? new Set(companies.map((c) => c.id)) : new Set())
              }}
            />
          </div>

          {/* Column headers */}
          {visibleCols.map((col) => {
            const isName = col.key === 'name'
            const effectiveW = colWidths[col.key] ?? col.width
            const isSorted = sort.key === col.key
            const canPin = isPinnable(col)
            const isPinned = canPin && summaryKeys.includes(col.key)
            return (
              <div
                key={col.key}
                className={`${styles.headerCell} ${isName ? styles.nameCol : ''} ${col.sortable ? styles.sortable : ''}`}
                onClick={() => handleHeaderClick(col)}
              >
                {col.label}
                {col.sortable && (
                  isSorted
                    ? <span className={styles.sortArrow}>{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>
                    : <span className={styles.sortArrowHint}>↕</span>
                )}
                {canPin && (
                  <button
                    className={`${styles.pinBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                    title={isPinned ? 'Remove from detail summary' : 'Pin to detail summary'}
                    onClick={(e) => { e.stopPropagation(); toggleSummaryField(col.key) }}
                  >
                    📌
                  </button>
                )}
                <div
                  className={styles.resizeHandle}
                  onMouseDown={(e) => onResizeMouseDown(e, col.key, effectiveW)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )
          })}

          {/* Column picker */}
          <div className={`${styles.headerCell} ${styles.pickerCell}`}>
            <ColumnPicker
              visibleKeys={visibleKeys}
              allDefs={COLUMN_DEFS}
              onChange={onVisibleKeysChange}
              onSave={saveColumnConfig}
            />
          </div>
        </div>

        {/* Virtual body */}
        <div
          className={styles.virtualBody}
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {loading && companies.length === 0 && (
            <div className={styles.emptyRow}>Loading…</div>
          )}
          {!loading && companies.length === 0 && (
            <div className={styles.emptyRow}>No companies found.</div>
          )}

          {virtualRows.map((vrow) => {
            const company = companies[vrow.index]
            const isSelected = selectedIds.has(company.id)

            return (
              <div
                key={company.id}
                className={`${styles.dataRow} ${isSelected ? styles.selected : ''}`}
                style={{
                  gridTemplateColumns: gridCols,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vrow.start}px)`
                }}
              >
                {/* Checkbox */}
                <div className={`${styles.checkboxCol} ${styles.checkboxCell}`}>
                  <input
                    type="checkbox"
                    className={styles.checkboxInput}
                    checked={isSelected}
                    onChange={(e) => toggleSelect(company.id, vrow.index, (e.nativeEvent as MouseEvent).shiftKey)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>

                {/* Name cell (sticky, navigates) */}
                {visibleCols[0]?.key === 'name' && (
                  <div
                    className={`${styles.nameCol} ${styles.nameCell}`}
                    onClick={() => {
                      setEditCell(null)
                      navigate(`/company/${company.id}`)
                    }}
                  >
                    {company.primaryDomain && (
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.primaryDomain)}&sz=32`}
                        alt=""
                        className={styles.favicon}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    <span className={styles.nameText}>{company.canonicalName}</span>
                  </div>
                )}

                {/* Editable cells for remaining columns */}
                {visibleCols.slice(1).map((col, relIdx) => {
                  const colIdx = relIdx + 1
                  const fieldKey = col.field as keyof CompanySummary
                  const isCellFocused = editCell?.rowIdx === vrow.index && editCell?.colIdx === colIdx

                  return (
                    <EditableCell
                      key={col.key}
                      value={col.field ? company[fieldKey] : null}
                      col={col}
                      isFocused={isCellFocused}
                      onStartEdit={() => handleStartEdit(vrow.index, colIdx)}
                      onEndEdit={(dir) => handleEndEdit(vrow.index, colIdx, dir ?? null)}
                      onSave={async (newVal) => {
                        if (!col.field) return
                        await handleCellSave(company, col.field, newVal)
                      }}
                    />
                  )
                })}

                {/* Picker spacer cell */}
                <div />
              </div>
            )
          })}
        </div>

        {/* Inline add row */}
        <div
          className={styles.addRow}
          style={{ gridTemplateColumns: gridCols }}
          onClick={() => { if (!addingRow) setAddingRow(true) }}
        >
          <div /> {/* checkbox spacer */}
          <div className={styles.addRowCell}>
            {addingRow ? (
              <input
                ref={addInputRef}
                className={styles.addRowInput}
                placeholder="Company name…"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleAddRowSubmit() }
                  if (e.key === 'Escape') { setAddingRow(false); setAddName('') }
                }}
                onBlur={() => { if (!addName.trim()) { setAddingRow(false) } }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>+ Add a company</>
            )}
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className={styles.bulkBar}>
          <button className={styles.bulkClear} onClick={() => setSelectedIds(new Set())}>
            {selectedIds.size} selected ✕
          </button>

          {/* Edit fields button + dropdown */}
          <div className={styles.bulkMenuWrap} ref={bulkEditRef}>
            <button
              className={styles.bulkMenuBtn}
              onClick={() => setBulkEditOpen((v) => !v)}
              disabled={bulkEditing || bulkDeleting}
            >
              {bulkEditing ? 'Saving…' : 'Edit fields ▾'}
            </button>
            {bulkEditOpen && (
              <div className={`${styles.bulkMenu} ${styles.bulkEditDropdown}`}>
                {/* Field tabs */}
                <div className={styles.bulkEditTabs}>
                  {BULK_EDIT_FIELDS.map((f) => (
                    <button
                      key={f.key}
                      className={`${styles.bulkEditTab} ${bulkEditField === f.key ? styles.bulkEditTabActive : ''}`}
                      onClick={() => { setBulkEditField(f.key); setBulkEditValue('') }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                {/* Value options */}
                <div className={styles.bulkEditOptions}>
                  {currentBulkField.options.map((o) => (
                    <label key={o.value} className={styles.bulkEditOption}>
                      <input
                        type="radio"
                        name="bulkEditValue"
                        value={o.value}
                        checked={bulkEditValue === o.value}
                        onChange={() => setBulkEditValue(o.value)}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
                <div className={styles.bulkEditApply}>
                  <button
                    className={styles.bulkEditApplyBtn}
                    onClick={() => void handleBulkEdit()}
                    disabled={bulkEditValue === '' && bulkEditField === 'entityType'}
                  >
                    Apply to {selectedIds.size} compan{selectedIds.size !== 1 ? 'ies' : 'y'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Delete button */}
          <button
            className={`${styles.bulkMenuBtn} ${styles.bulkMenuBtnDanger}`}
            onClick={() => void handleBulkDelete()}
            disabled={bulkDeleting || bulkEditing}
          >
            {bulkDeleting ? 'Working…' : `Delete ${selectedIds.size}`}
          </button>
        </div>
      )}
    </>
  )
}
