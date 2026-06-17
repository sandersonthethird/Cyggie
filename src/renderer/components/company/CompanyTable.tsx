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
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { buildBackState } from '../../utils/backNavState'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanySummary } from '../../../shared/types/company'
import { EditableCell } from './EditableCell'
import { ColumnPicker } from './ColumnPicker'
import { InvestorChipsCell } from '../crm/InvestorChipsCell'
import type { InvestorEntry } from '../../hooks/useInvestorChips'
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
import { executeBulkEdit, createCellCallbacks } from '../crm/tableUtils'
import type { RangeValue } from '../crm/tableUtils'
import type { VirtualRow } from '../../hooks/useGroupedRows'
import { chipStyle } from '../../utils/colorChip'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { useColumnResize } from '../../hooks/useColumnResize'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { useEditCellNav, getRangePosition, getCellEdges, cellEdgeBoxShadow, effectiveCells, isCellSelected } from '../../hooks/useEditCellNav'
import { useRowSelection } from '../../hooks/useRowSelection'
import { useCellClipboard } from '../../hooks/useCellClipboard'
import { HeaderFilter } from '../crm/HeaderFilter'
import { RangeFilter } from '../crm/RangeFilter'
import { TextFilter } from '../crm/TextFilter'
import { usePreferencesStore } from '../../stores/preferences.store'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import { shouldPromptDecisionLog, defaultDecisionType } from '../../utils/decisionLogTrigger'
import type { CompanyPipelineStage } from '../../../shared/types/company'
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
  /** Mixed virtual rows — group headers + data rows. Provided by useGroupedRows in parent. */
  rows: VirtualRow<CompanySummary>[]
  groupBy: string | null
  onToggleGroup: (groupKey: string) => void
  loading: boolean
  sort: SortState
  onSort: (key: string, shiftHeld: boolean) => void
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onBulkDelete: (ids: string[]) => void
  onCreateInline: (name: string) => Promise<void>
  /** Lifted from internal state — parent (Companies.tsx) owns this for saved views. */
  visibleKeys: string[]
  onVisibleKeysChange: (keys: string[]) => void
  /** Active filter values per field — drives HeaderFilter badge + checked state. */
  columnFilters: Record<string, string[]>
  onColumnFilter: (field: string, values: string[]) => void
  /** Active range filters per field (number + date columns). */
  rangeFilters?: Record<string, RangeValue>
  onRangeFilter?: (field: string, range: RangeValue) => void
  /** Active text filters per field (text columns). */
  textFilters?: Record<string, string>
  onTextFilter?: (field: string, value: string) => void
  /** All column defs including custom fields. Falls back to COLUMN_DEFS if absent. */
  allDefs?: ColumnDef[]
  /** Custom field values keyed by [entityId][fieldDefinitionId]. */
  customFieldValues?: Record<string, Record<string, string>>
  onRenameColumn?: (key: string, label: string) => void
  onHideColumn?: (key: string) => void
  onDeleteColumn?: (key: string) => Promise<void>
  onCreateField?: () => void
  onPatchCustomField?: (entityId: string, defId: string, value: string | null) => void
}

export function CompanyTable({
  companies,
  rows,
  groupBy,
  onToggleGroup,
  loading,
  sort,
  onSort,
  onPatch,
  onBulkDelete,
  onCreateInline,
  visibleKeys,
  onVisibleKeysChange,
  columnFilters,
  onColumnFilter,
  rangeFilters,
  onRangeFilter,
  textFilters,
  onTextFilter,
  allDefs,
  customFieldValues,
  onRenameColumn,
  onHideColumn,
  onDeleteColumn,
  onCreateField,
  onPatchCustomField
}: CompanyTableProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { getJSON, setJSON } = usePreferencesStore()
  const { companyDefs } = useCustomFieldStore()
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
  const { colWidths, onResizeMouseDown } = useColumnResize(loadColumnWidths(), saveColumnWidths)

  // ── Column drag reorder ─────────────────────────────────────────────────────
  // saveColumnConfig is a stable module-level export — safe to pass directly.
  const { draggingKey, dragOverKey, getDragProps } = useColumnDrag(
    visibleKeys, onVisibleKeysChange, saveColumnConfig, 'name'
  )

  const effectiveDefs = allDefs ?? COLUMN_DEFS
  const visibleCols = useMemo<ColumnDef[]>(
    () => visibleKeys.flatMap((k) => effectiveDefs.find((c) => c.key === k) ?? []),
    [visibleKeys, effectiveDefs]
  )

  // Merge user-added options from DB into builtin select columns so they appear in dropdowns
  const mergedVisibleCols = useMemo<ColumnDef[]>(
    () => visibleCols.map((col) => {
      if (col.type !== 'select' || col.key.startsWith('custom:')) return col
      const builtinDef = companyDefs.find(d => d.isBuiltin && d.fieldKey === col.key)
      if (!builtinDef?.optionsJson) return col
      return { ...col, options: mergeBuiltinOptions(col.options ?? [], builtinDef.optionsJson) }
    }),
    [visibleCols, companyDefs]
  )

  // grid-template-columns: checkbox | name | ...rest | picker
  const gridCols = useMemo(() => {
    const cols = visibleCols.map((c) => `${colWidths[c.key] ?? c.width}px`)
    return `${CHECKBOX_WIDTH}px ${cols.join(' ')} ${PICKER_WIDTH}px`
  }, [visibleCols, colWidths])

  // ── Column header filters ──────────────────────────────────────────────────
  const [filterOpenCol, setFilterOpenCol] = useState<string | null>(null)
  const handleFilterClose = useCallback(() => setFilterOpenCol(null), [])

  // ── Column rename ──────────────────────────────────────────────────────────
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // ── Column header context menu ─────────────────────────────────────────────
  const [headerMenu, setHeaderMenu] = useState<{
    key: string; x: number; y: number; pendingDelete: boolean
  } | null>(null)
  const headerMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!headerMenu) return
    function handle(e: MouseEvent) {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setHeaderMenu(null)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [headerMenu])

  // ── Selection ──────────────────────────────────────────────────────────────
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkEditing, setBulkEditing] = useState(false)
  const [bulkEditError, setBulkEditError] = useState<string | null>(null)
  const [bulkEditField, setBulkEditField] = useState<BulkFieldKey>('entityType')
  const [bulkEditValue, setBulkEditValue] = useState<string>('')
  const bulkEditRef = useRef<HTMLDivElement>(null)

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

  // ── Edit cell nav ──────────────────────────────────────────────────────────
  // (scrollToRow / scrollToCol are defined below after rowVirtualizer + DOM
  // measurement — forward-ref via closure)
  const scrollToRowRef = useRef<(idx: number) => void>(() => {})
  const scrollToColRef = useRef<(idx: number) => void>(() => {})

  const {
    selection, focusedCell, editCell, setEditCell, cellRange,
    handleFocusCell, handleStartEdit, handleSelectCellClick, handleEndEdit, handleKeyboardEvent,
  } = useEditCellNav(
    companies.length,
    visibleCols,
    (idx) => scrollToRowRef.current(idx),
    (idx) => scrollToColRef.current(idx),
  )

  const getEditCell = useCallback(() => editCell, [editCell])

  // ── Row selection ──────────────────────────────────────────────────────────
  const { selectedIds, setSelectedIds, toggleSelect, handleTableKeyDown, lastSelectedIdxRef } = useRowSelection(
    companies,
    (idx) => scrollToRowRef.current(idx),
    getEditCell
  )

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
        return [id, company ? (company as unknown as Record<string, unknown>)[bulkEditField] : null]
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

  // ── Decision-log prompt (fires when stage moves to a terminal value) ────────
  const [pendingDecisionCompany, setPendingDecisionCompany] =
    useState<{ id: string; stage: CompanyPipelineStage; entityType: string } | null>(null)

  // ── Cell callbacks (for clipboard + inline edit) ────────────────────────────
  const handleCellSave = useCallback(
    async (company: CompanySummary, field: string, newValue: string | null) => {
      const patch: Record<string, unknown> = { [field]: newValue === '' ? null : newValue }
      await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, patch)
      onPatch(company.id, patch)
      if (field === 'pipelineStage' && newValue) {
        const newStage = newValue as CompanyPipelineStage
        const entityType = company.entityType ?? 'unknown'
        if (shouldPromptDecisionLog(company.pipelineStage, newStage, entityType, entityType)) {
          setPendingDecisionCompany({ id: company.id, stage: newStage, entityType })
        }
      }
    },
    [onPatch]
  )

  const { getCellValue, saveCellValue } = useMemo(() => createCellCallbacks<CompanySummary>({
    getCustomFieldValue: (entityId, cfId) => customFieldValues?.[entityId]?.[cfId] ?? null,
    saveCustomField: async (entityId, col, value) => {
      const cfId = col.key.slice(7)
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, {
        fieldDefinitionId: cfId,
        entityType: 'company',
        entityId,
        valueText: col.type === 'number' ? null : (value || null),
        valueNumber: col.type === 'number' ? (value ? parseFloat(value) : null) : null,
      })
      onPatchCustomField?.(entityId, cfId, value)
    },
    saveRegularField: handleCellSave,
    getComputedValue: (entity, col) => {
      if (col.key === 'location') return [entity.city, entity.state].filter(Boolean).join(', ') || null
      return null
    },
  }), [customFieldValues, handleCellSave, onPatchCustomField])

  // ── Clipboard ──────────────────────────────────────────────────────────────
  const {
    copiedCell, copiedRange, copiedCells, clipboardToast, undoAction,
    handleClipboardKeyDown, handleUndo, dismissUndo, fillSelection,
  } = useCellClipboard({
    rows: companies,
    visibleCols: mergedVisibleCols,
    focusedCell,
    editCell,
    cellRange,
    selection,
    selectedIds,
    getCellValue,
    saveCellValue,
    onStartEdit: handleStartEdit,
  })

  // ── Composed keyboard handler ──────────────────────────────────────────────
  // useEditCellNav owns Arrow/Enter/Escape/type-to-edit. Suppress its Escape
  // when the clipboard hook is in "copied" mode so Esc clears the copy state first.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (handleKeyboardEvent(e, { suppressEscape: !!(copiedCell || copiedRange) })) return
    handleClipboardKeyDown(e)
    handleTableKeyDown(e)
  }, [handleKeyboardEvent, copiedCell, copiedRange, handleClipboardKeyDown, handleTableKeyDown])

  // ── Sort ───────────────────────────────────────────────────────────────────
  function handleHeaderClick(col: ColumnDef, e: React.MouseEvent) {
    if (!col.sortable) return
    onSort(col.key, e.shiftKey)
  }

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
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rows[i]?.type === 'group' ? 36 : ROW_HEIGHT,
    overscan: 6
  })

  function scrollToRow(idx: number) {
    rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
  }
  // Wire scrollToRowRef so hooks defined above can call scrollToRow
  scrollToRowRef.current = scrollToRow

  /**
   * Bring the column at colIdx (index into visibleCols) into horizontal view.
   * See ContactTable.scrollToCol for the rationale — same layout assumptions:
   * sticky checkbox + sticky name column on the left.
   */
  function scrollToCol(colIdx: number) {
    const wrapper = scrollRef.current
    if (!wrapper) return
    if (colIdx <= 0) return  // name col is sticky

    const widthAt = (i: number) =>
      colWidths[visibleCols[i]?.key ?? ''] ?? visibleCols[i]?.width ?? 0

    let leftEdge = CHECKBOX_WIDTH
    for (let i = 0; i < colIdx; i++) leftEdge += widthAt(i)
    const rightEdge = leftEdge + widthAt(colIdx)

    const stickyW = CHECKBOX_WIDTH + widthAt(0)
    const { scrollLeft, clientWidth } = wrapper

    if (leftEdge < scrollLeft + stickyW) {
      wrapper.scrollLeft = leftEdge - stickyW
    } else if (rightEdge > scrollLeft + clientWidth) {
      wrapper.scrollLeft = rightEdge - clientWidth
    }
  }
  scrollToColRef.current = scrollToCol

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

      <div
        className={styles.tableWrapper}
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => {
          // Re-focus wrapper after mouse interactions so keyboard shortcuts keep working.
          // Only refocus if the click target isn't an input/select (don't steal focus from edit mode).
          const tag = (e.target as HTMLElement).tagName
          if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
            // Use requestAnimationFrame so the click completes first (e.g. checkbox toggle)
            requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
          }
        }}
      >
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
          {mergedVisibleCols.map((col) => {
            const isName = col.key === 'name'
            const effectiveW = colWidths[col.key] ?? col.width
            const sortIdx = sort.findIndex((s) => s.key === col.key)
            const isSorted = sortIdx >= 0
            const sortDir = isSorted ? sort[sortIdx].dir : null
            const canPin = isPinnable(col)
            const isPinned = canPin && summaryKeys.includes(col.key)
            return (
              <div
                key={col.key}
                className={`${styles.headerCell} ${isName ? styles.nameCol : ''} ${col.sortable ? styles.sortable : ''} ${(col.options?.length || col.type === 'number' || col.type === 'date' || col.type === 'text') ? styles.filterableCell : ''} ${draggingKey === col.key ? styles.dragging : ''} ${dragOverKey === col.key ? styles.dragOver : ''}`}
                onClick={(e) => { if (renamingCol !== col.key) handleHeaderClick(col, e) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setHeaderMenu({ key: col.key, x: e.clientX, y: e.clientY, pendingDelete: false })
                  setRenameValue(col.label)
                }}
                {...getDragProps(col.key)}
              >
                {renamingCol === col.key ? (
                  <input
                    className={styles.renameInput}
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRenameColumn?.(col.key, renameValue)
                        setRenamingCol(null)
                      }
                      if (e.key === 'Escape') setRenamingCol(null)
                    }}
                    onBlur={() => setRenamingCol(null)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : col.label}
                {col.sortable && (
                  isSorted
                    ? <span className={styles.sortArrow}>
                        {sortDir === 'asc' ? ' ▲' : ' ▼'}
                        {sort.length > 1 && <sup className={styles.sortBadge}>{sortIdx + 1}</sup>}
                      </span>
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
                {col.options && col.options.filter((o) => o.value !== '').length > 0 && (
                  <HeaderFilter
                    label={col.label}
                    options={col.options.filter((o) => o.value !== '')}
                    activeValues={columnFilters[col.field ?? col.key] ?? []}
                    isOpen={filterOpenCol === col.key}
                    onOpen={() => setFilterOpenCol((prev) => prev === col.key ? null : col.key)}
                    onClose={handleFilterClose}
                    onToggle={(value) => {
                      const field = col.field ?? col.key
                      const current = columnFilters[field] ?? []
                      const next = current.includes(value)
                        ? current.filter((v) => v !== value)
                        : [...current, value]
                      onColumnFilter(field, next)
                    }}
                  />
                )}
                {(col.type === 'number' || col.type === 'date') && (
                  <RangeFilter
                    colType={col.type}
                    label={col.label}
                    range={rangeFilters?.[col.field ?? col.key] ?? {}}
                    isOpen={filterOpenCol === `range_${col.key}`}
                    onOpen={() => setFilterOpenCol((prev) => prev === `range_${col.key}` ? null : `range_${col.key}`)}
                    onClose={handleFilterClose}
                    onChange={(range) => onRangeFilter?.(col.field ?? col.key, range)}
                    prefix={col.prefix ?? ''}
                    suffix={col.suffix ?? ''}
                  />
                )}
                {col.type === 'text' && (
                  <TextFilter
                    label={col.label}
                    value={textFilters?.[col.field ?? col.key] ?? ''}
                    isOpen={filterOpenCol === `text_${col.key}`}
                    onOpen={() => setFilterOpenCol((prev) => prev === `text_${col.key}` ? null : `text_${col.key}`)}
                    onClose={handleFilterClose}
                    onChange={(v) => onTextFilter?.(col.field ?? col.key, v)}
                  />
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
              allDefs={effectiveDefs}
              onChange={onVisibleKeysChange}
              onSave={saveColumnConfig}
              onCreateField={onCreateField}
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
            const row = rows[vrow.index]
            if (!row) return null

            const absoluteStyle: React.CSSProperties = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vrow.start}px)`
            }

            // ── Group header row ──────────────────────────────────────────────
            if (row.type === 'group') {
              return (
                <div
                  key={`group:${row.value ?? '__null__'}`}
                  className={styles.groupHeaderRow}
                  style={absoluteStyle}
                  onClick={() => onToggleGroup(row.value ?? '__null__')}
                >
                  <span className={styles.groupToggle}>{row.isCollapsed ? '▶' : '▼'}</span>
                  <span className={styles.groupChip} style={chipStyle(row.label)}>{row.label}</span>
                  <span className={styles.groupCount}>{row.count}</span>
                </div>
              )
            }

            // ── Data row ─────────────────────────────────────────────────────
            const company = row.item
            const dataIndex = row.dataIndex
            const isSelected = selectedIds.has(company.id)

            return (
              <div
                key={company.id}
                className={`${styles.dataRow} ${isSelected ? styles.selected : ''}`}
                style={{
                  gridTemplateColumns: gridCols,
                  ...absoluteStyle
                }}
              >
                {/* Checkbox */}
                <div className={`${styles.checkboxCol} ${styles.checkboxCell}`}>
                  <input
                    type="checkbox"
                    className={styles.checkboxInput}
                    checked={isSelected}
                    onChange={(e) => toggleSelect(company.id, dataIndex, (e.nativeEvent as MouseEvent).shiftKey)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>

                {/* Name cell (sticky, navigates) */}
                {visibleCols[0]?.key === 'name' && (
                  <div
                    className={`${styles.nameCol} ${styles.nameCell}`}
                    onClick={() => {
                      setEditCell(null)
                      navigate(`/company/${company.id}`, { state: buildBackState(location, 'Companies') })
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
                {mergedVisibleCols.slice(1).map((col, relIdx) => {
                  const colIdx = relIdx + 1
                  const customFieldId = col.key.startsWith('custom:') ? col.key.slice(7) : null
                  const cellValue = getCellValue(company, col)
                  const isCustomSelect = !!customFieldId && col.type === 'select'

                  const isCellEditing = editCell?.rowIdx === dataIndex && editCell?.colIdx === colIdx
                  const edges = isCellEditing ? null : getCellEdges(selection, dataIndex, colIdx)
                  const selBoxShadow = cellEdgeBoxShadow(edges)
                  const copiedPos = getRangePosition(dataIndex, colIdx, copiedRange, copiedCell)
                  const isCopiedMulti = !!copiedCells && copiedCells.some((c) => c.row === dataIndex && c.col === colIdx)

                  // When groupBy is active: scan mode — all cells navigate to detail
                  if (groupBy) {
                    return (
                      <div
                        key={col.key}
                        className={isCustomSelect ? styles.chipCell : styles.dataCell}
                        onClick={() => navigate(`/company/${company.id}`, { state: buildBackState(location, 'Companies') })}
                      >
                        {isCustomSelect && cellValue ? (
                          <span className={styles.chip} style={chipStyle(cellValue)}>{cellValue}</span>
                        ) : (!isCustomSelect ? cellValue : null)}
                      </div>
                    )
                  }

                  if (isCustomSelect && !isCellEditing) {
                    const chipCopiedClass = copiedPos
                      ? copiedPos === 'only' ? styles.copiedCell
                        : copiedPos === 'top' ? styles.copiedRangeTop
                        : copiedPos === 'mid' ? styles.copiedRangeMid
                        : styles.copiedRangeBot
                      : (isCopiedMulti ? styles.copiedCell : '')
                    return (
                      <div
                        key={col.key}
                        className={`${styles.chipCell} ${chipCopiedClass}`.trim()}
                        style={selBoxShadow ? { boxShadow: selBoxShadow } : undefined}
                        onClick={(e) => handleSelectCellClick(dataIndex, colIdx, e.shiftKey, e.metaKey || e.ctrlKey)}
                        onDoubleClick={() => handleStartEdit(dataIndex, colIdx)}
                      >
                        {cellValue ? (
                          <span className={styles.chip} style={chipStyle(cellValue)}>
                            {cellValue}
                          </span>
                        ) : null}
                      </div>
                    )
                  }

                  const wrapperCopiedClass = copiedPos
                    ? copiedPos === 'only' ? styles.copiedCell
                      : copiedPos === 'top' ? styles.copiedRangeTop
                      : copiedPos === 'mid' ? styles.copiedRangeMid
                      : styles.copiedRangeBot
                    : (isCopiedMulti ? styles.copiedCell : undefined)

                  // Investor chips cell — four column variants:
                  //   coInvestorNames           → company.coInvestorsList         → patch coInvestorsList
                  //   priorInvestorNames        → company.priorInvestorsList      → patch priorInvestorsList
                  //   subsequentInvestorNames   → company.subsequentInvestorsList → patch subsequentInvestorsList
                  //   leadInvestor              → company.leadInvestorCompany     → patch leadInvestorCompanyId
                  if (col.type === 'investor_chips') {
                    let investorList: Array<{ id: string; name: string; domain: string | null }>
                    let handleSave: (next: InvestorEntry[]) => Promise<void>
                    if (col.key === 'leadInvestor') {
                      investorList = company.leadInvestorCompany ? [company.leadInvestorCompany] : []
                      handleSave = async (next) => {
                        const patch: Record<string, unknown> = {
                          leadInvestorCompanyId: next.length > 0 ? next[0].id : null,
                        }
                        await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, patch)
                        onPatch(company.id, patch)
                      }
                    } else {
                      const variant: 'co' | 'prior' | 'subsequent' =
                        col.key === 'subsequentInvestorNames' ? 'subsequent'
                        : col.key === 'priorInvestorNames' ? 'prior'
                        : 'co'
                      investorList =
                        variant === 'subsequent' ? company.subsequentInvestorsList
                        : variant === 'prior' ? company.priorInvestorsList
                        : company.coInvestorsList
                      const patchKey =
                        variant === 'subsequent' ? 'subsequentInvestorsList'
                        : variant === 'prior' ? 'priorInvestorsList'
                        : 'coInvestorsList'
                      handleSave = async (next) => {
                        const patch: Record<string, unknown> = { [patchKey]: next }
                        await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, company.id, patch)
                        onPatch(company.id, patch)
                      }
                    }
                    return (
                      <div
                        key={col.key}
                        className={`${styles.chipCell} ${wrapperCopiedClass ?? ''}`.trim()}
                        style={selBoxShadow ? { boxShadow: selBoxShadow } : undefined}
                        onClick={(e) => handleFocusCell(dataIndex, colIdx, e.shiftKey, e.metaKey || e.ctrlKey)}
                      >
                        <InvestorChipsCell
                          value={investorList}
                          onSave={handleSave}
                          isEditing={isCellEditing}
                          onStartEdit={() => handleStartEdit(dataIndex, colIdx)}
                          onEndEdit={() => handleEndEdit(dataIndex, colIdx, null)}
                          scrollContainer={scrollRef.current}
                          maxChips={col.maxChips}
                        />
                      </div>
                    )
                  }

                  return (
                    <div key={col.key} className={wrapperCopiedClass}>
                      <EditableCell
                        value={cellValue}
                        col={col}
                        edges={edges}
                        isEditing={isCellEditing}
                        initialChar={isCellEditing ? editCell?.initialChar : undefined}
                        scrollContainer={scrollRef.current}
                        onFocus={(shiftKey, metaKey) => handleFocusCell(dataIndex, colIdx, shiftKey, metaKey)}
                        onStartEdit={() => handleStartEdit(dataIndex, colIdx)}
                        onEndEdit={(dir) => handleEndEdit(dataIndex, colIdx, dir ?? null)}
                        onAddOption={
                          col.type === 'select'
                            ? async (newOption) => {
                                if (customFieldId) {
                                  const def = useCustomFieldStore.getState().companyDefs.find(d => d.id === customFieldId)
                                  await addCustomFieldOption(customFieldId, def?.optionsJson ?? null, newOption)
                                } else {
                                  const builtinDef = useCustomFieldStore.getState().companyDefs.find(d => d.isBuiltin && d.fieldKey === col.key)
                                  if (builtinDef) await addCustomFieldOption(builtinDef.id, builtinDef.optionsJson, newOption)
                                }
                              }
                            : undefined
                        }
                        onSave={async (newVal) => {
                          // Bulk-fill: if this cell is part of a multi-cell selection,
                          // the committed value fans out to every selected cell in
                          // this column; otherwise it's a normal single-cell save.
                          if (isCellSelected(selection, dataIndex, colIdx) && effectiveCells(selection).length > 1) {
                            await fillSelection(colIdx, newVal)
                          } else {
                            await saveCellValue(company, col, newVal)
                          }
                        }}
                      />
                    </div>
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

      {/* Column header context menu */}
      {headerMenu && (() => {
        const menuCol = effectiveDefs.find((c) => c.key === headerMenu.key)
        return createPortal(
          <div
            ref={headerMenuRef}
            className={styles.headerContextMenu}
            style={{ top: headerMenu.y, left: headerMenu.x }}
          >
            {headerMenu.pendingDelete ? (
              <>
                <div className={styles.headerMenuConfirm}>
                  Delete &ldquo;{menuCol?.label}&rdquo;? This removes all data.
                </div>
                <button
                  className={styles.headerMenuItem}
                  onClick={() => setHeaderMenu((m) => m && { ...m, pendingDelete: false })}
                >
                  Cancel
                </button>
                <button
                  className={`${styles.headerMenuItem} ${styles.headerMenuItemDanger}`}
                  onClick={async () => {
                    setHeaderMenu(null)
                    await onDeleteColumn?.(headerMenu.key)
                  }}
                >
                  Delete field
                </button>
              </>
            ) : (
              <>
                {onRenameColumn && (
                  <button
                    className={styles.headerMenuItem}
                    onClick={() => {
                      setHeaderMenu(null)
                      setRenamingCol(headerMenu.key)
                    }}
                  >
                    Rename
                  </button>
                )}
                {headerMenu.key !== 'name' && (
                  <button
                    className={styles.headerMenuItem}
                    onClick={() => {
                      onHideColumn?.(headerMenu.key)
                      setHeaderMenu(null)
                    }}
                  >
                    Hide column
                  </button>
                )}
                {headerMenu.key.startsWith('custom:') && onDeleteColumn && (
                  <button
                    className={`${styles.headerMenuItem} ${styles.headerMenuItemDanger}`}
                    onClick={() => setHeaderMenu((m) => m && { ...m, pendingDelete: true })}
                  >
                    Delete field
                  </button>
                )}
              </>
            )}
          </div>,
          document.body
        )
      })()}

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

      {/* Clipboard toast */}
      {clipboardToast && (
        <div className={styles.clipboardToast}>{clipboardToast}</div>
      )}

      {/* Undo toast */}
      {undoAction && (
        <div className={styles.clipboardToast}>
          {undoAction.label} {undoAction.count} cell{undoAction.count !== 1 ? 's' : ''}
          <button className={styles.undoBtn} onClick={() => void handleUndo()}>Undo</button>
          <button className={styles.undoDismiss} onClick={dismissUndo}>✕</button>
        </div>
      )}

      {pendingDecisionCompany && (
        <DecisionLogModal
          companyId={pendingDecisionCompany.id}
          initialDecisionType={defaultDecisionType(pendingDecisionCompany.stage, pendingDecisionCompany.entityType)}
          onClose={() => setPendingDecisionCompany(null)}
          onSaved={() => setPendingDecisionCompany(null)}
        />
      )}
    </>
  )
}
