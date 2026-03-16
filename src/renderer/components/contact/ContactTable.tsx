/**
 * ContactTable — Attio-style div-grid table for the contacts list.
 *
 * Mirrors CompanyTable architecture exactly. Reuses:
 *   - EditableCell (with contactType badge support)
 *   - ColumnPicker (now generic via allDefs + onSave props)
 *   - formatLastTouch / daysSince (via EditableCell internals)
 *   - TanStack Virtual for large lists
 *
 * Data flow:
 *   parent passes filteredContacts[] (already sorted + filtered)
 *   → ContactTable renders virtual rows
 *   → EditableCell onSave → parent patches contacts[]
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactSummary } from '../../../shared/types/contact'
import { EditableCell } from '../company/EditableCell'
import { ColumnPicker } from '../company/ColumnPicker'
import {
  CONTACT_COLUMN_DEFS,
  CONTACT_HEADER_KEYS,
  CONTACT_TYPES,
  saveContactColumnConfig,
  loadContactColumnWidths,
  saveContactColumnWidths,
  type ColumnDef,
  type SortState
} from './contactColumns'
import { useColumnResize } from '../../hooks/useColumnResize'
import { useColumnDrag } from '../../hooks/useColumnDrag'
import { useEditCellNav } from '../../hooks/useEditCellNav'
import { useRowSelection } from '../../hooks/useRowSelection'
import { executeBulkEdit } from '../crm/tableUtils'
import type { RangeValue } from '../crm/tableUtils'
import { chipStyle } from '../../utils/colorChip'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { HeaderFilter } from '../crm/HeaderFilter'
import { RangeFilter } from '../crm/RangeFilter'
import { TextFilter } from '../crm/TextFilter'
import { usePreferencesStore } from '../../stores/preferences.store'
import styles from './ContactTable.module.css'
import { api } from '../../api'

const CHECKBOX_WIDTH = 40
const PICKER_WIDTH = 44
const ROW_HEIGHT = 38

interface ContactTableProps {
  contacts: ContactSummary[]
  loading: boolean
  sort: SortState
  onSort: (key: string, dir: 'asc' | 'desc') => void
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onBulkDelete: (ids: string[]) => void
  /** Lifted from internal state — parent (Contacts.tsx) owns this for saved views. */
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
  /** All column defs including custom fields. Falls back to CONTACT_COLUMN_DEFS if absent. */
  allDefs?: ColumnDef[]
  /** Custom field values keyed by [entityId][fieldDefinitionId]. */
  customFieldValues?: Record<string, Record<string, string>>
  onRenameColumn?: (key: string, label: string) => void
  onCreateField?: () => void
  onPatchCustomField?: (entityId: string, defId: string, value: string | null) => void
}

export function ContactTable({
  contacts,
  loading,
  sort,
  onSort,
  onPatch,
  onBulkDelete,
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
  onCreateField,
  onPatchCustomField
}: ContactTableProps) {
  const navigate = useNavigate()
  const { getJSON, setJSON } = usePreferencesStore()
  const { contactDefs } = useCustomFieldStore()
  const summaryKeys = getJSON<string[]>('cyggie:contact-summary-fields', [])

  function toggleSummaryField(key: string) {
    const next = summaryKeys.includes(key)
      ? summaryKeys.filter((k) => k !== key)
      : [...summaryKeys, key]
    setJSON('cyggie:contact-summary-fields', next)
  }

  function isPinnable(col: ColumnDef): boolean {
    return col.type !== 'computed' && col.field != null && !CONTACT_HEADER_KEYS.has(col.key)
  }

  // ── Column widths ──────────────────────────────────────────────────────────
  const { colWidths, onResizeMouseDown } = useColumnResize(loadContactColumnWidths(), saveContactColumnWidths)

  // ── Column drag reorder ─────────────────────────────────────────────────────
  // saveContactColumnConfig is a stable module-level export — safe to pass directly.
  const { draggingKey, dragOverKey, getDragProps } = useColumnDrag(
    visibleKeys, onVisibleKeysChange, saveContactColumnConfig, 'name'
  )

  const effectiveDefs = allDefs ?? CONTACT_COLUMN_DEFS
  const visibleCols = useMemo<ColumnDef[]>(
    () => visibleKeys.flatMap((k) => effectiveDefs.find((c) => c.key === k) ?? []),
    [visibleKeys, effectiveDefs]
  )

  // Merge user-added options from DB into builtin select columns so they appear in dropdowns
  const mergedVisibleCols = useMemo<ColumnDef[]>(
    () => visibleCols.map((col) => {
      if (col.type !== 'select' || col.key.startsWith('custom:')) return col
      const builtinDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === col.key)
      if (!builtinDef?.optionsJson) return col
      return { ...col, options: mergeBuiltinOptions(col.options ?? [], builtinDef.optionsJson) }
    }),
    [visibleCols, contactDefs]
  )

  const gridCols = useMemo(() => {
    const cols = visibleCols.map((c) => `${colWidths[c.key] ?? c.width}px`)
    return `${CHECKBOX_WIDTH}px ${cols.join(' ')} ${PICKER_WIDTH}px`
  }, [visibleCols, colWidths])

  // ── Selection ──────────────────────────────────────────────────────────────
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkEditing, setBulkEditing] = useState(false)
  const [bulkEditError, setBulkEditError] = useState<string | null>(null)
  const [bulkEditField, setBulkEditField] = useState<'contactType' | 'company'>('contactType')
  const [bulkEditValue, setBulkEditValue] = useState<string | null>(null)
  const bulkEditRef = useRef<HTMLDivElement>(null)

  // ── Undo ───────────────────────────────────────────────────────────────────
  interface UndoAction {
    field: string
    originals: Array<{ id: string; value: unknown }>
    count: number
  }
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Column header filters ──────────────────────────────────────────────────
  const [filterOpenCol, setFilterOpenCol] = useState<string | null>(null)
  const handleFilterClose = useCallback(() => setFilterOpenCol(null), [])

  // ── Column rename ──────────────────────────────────────────────────────────
  const [renamingCol, setRenamingCol] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

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

  // Cleanup undo timer on unmount
  useEffect(() => () => clearTimeout(undoTimerRef.current), [])

  // ── Edit cell nav ──────────────────────────────────────────────────────────
  // (scrollToRow is defined below after rowVirtualizer — forward-ref via closure)
  const scrollToRowRef = useRef<(idx: number) => void>(() => {})

  const { editCell, setEditCell, handleStartEdit, handleEndEdit } = useEditCellNav(
    contacts.length,
    visibleCols,
    (idx) => scrollToRowRef.current(idx)
  )

  const getEditCell = useCallback(() => editCell, [editCell])

  // ── Row selection ──────────────────────────────────────────────────────────
  const { selectedIds, setSelectedIds, toggleSelect, handleTableKeyDown, lastSelectedIdxRef } = useRowSelection(
    contacts,
    (idx) => scrollToRowRef.current(idx),
    getEditCell
  )

  function setUndoWithTimer(action: UndoAction) {
    clearTimeout(undoTimerRef.current)
    setUndoAction(action)
    undoTimerRef.current = setTimeout(() => setUndoAction(null), 7000)
  }

  async function handleUndo() {
    if (!undoAction) return
    const action = undoAction
    clearTimeout(undoTimerRef.current)
    setUndoAction(null)
    for (const { id, value } of action.originals) {
      onPatch(id, { [action.field]: value })
    }
    const origMap = new Map(action.originals.map((o) => [o.id, o.value]))
    await executeBulkEdit({
      ids: action.originals.map((o) => o.id),
      getOriginalValue: () => null,
      updateFn: (id) =>
        api.invoke(IPC_CHANNELS.CONTACT_UPDATE, id, { [action.field]: origMap.get(id) ?? null }),
      onPatch: () => {}
    })
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0 || bulkDeleting) return
    setBulkDeleting(true)
    const ids = Array.from(selectedIds)
    setSelectedIds(new Set())
    await Promise.all(ids.map((id) => api.invoke(IPC_CHANNELS.CONTACT_DELETE, id)))
    setBulkDeleting(false)
    onBulkDelete(ids)
  }

  async function handleBulkEdit() {
    if (selectedIds.size === 0 || bulkEditing || bulkEditValue === null) return
    setBulkEditOpen(false)
    setBulkEditing(true)
    setBulkEditError(null)

    const ids = Array.from(selectedIds)

    try {
      if (bulkEditField === 'contactType') {
        const value = bulkEditValue === '' ? null : bulkEditValue
        const originals = new Map(
          ids.map((id) => {
            const c = contacts.find((ct) => ct.id === id)
            return [id, c ? c.contactType : null]
          })
        )
        for (const id of ids) onPatch(id, { contactType: value })
        const { failedIds } = await executeBulkEdit({
          ids,
          getOriginalValue: (id) => originals.get(id) ?? null,
          updateFn: (id) => api.invoke(IPC_CHANNELS.CONTACT_UPDATE, id, { contactType: value }),
          onPatch: (id, val) => onPatch(id, { contactType: val })
        })
        const succeededContactType = ids.filter((id) => !failedIds.includes(id))
        if (succeededContactType.length > 0) {
          setUndoWithTimer({
            field: 'contactType',
            originals: succeededContactType.map((id) => ({ id, value: originals.get(id) ?? null })),
            count: succeededContactType.length
          })
        }
        if (failedIds.length > 0) {
          setBulkEditError(`${failedIds.length} of ${ids.length} updates failed`)
        } else {
          setSelectedIds(new Set())
        }
      } else {
        // company: text input — use CONTACT_SET_COMPANY
        const companyName = bulkEditValue.trim()
        if (!companyName) return
        const originals = new Map(
          ids.map((id) => {
            const c = contacts.find((ct) => ct.id === id)
            return [id, c ? c.primaryCompanyName : null]
          })
        )
        for (const id of ids) onPatch(id, { primaryCompanyName: companyName })
        const { failedIds } = await executeBulkEdit({
          ids,
          getOriginalValue: (id) => originals.get(id) ?? null,
          updateFn: (id) => api.invoke(IPC_CHANNELS.CONTACT_SET_COMPANY, id, companyName),
          onPatch: (id, val) => onPatch(id, { primaryCompanyName: val })
        })
        const succeededCompany = ids.filter((id) => !failedIds.includes(id))
        if (succeededCompany.length > 0) {
          setUndoWithTimer({
            field: 'primaryCompanyName',
            originals: succeededCompany.map((id) => ({ id, value: originals.get(id) ?? null })),
            count: succeededCompany.length
          })
        }
        if (failedIds.length > 0) {
          setBulkEditError(`${failedIds.length} of ${ids.length} updates failed`)
        } else {
          setSelectedIds(new Set())
        }
      }
    } finally {
      setBulkEditing(false)
    }
  }

  // ── Sort ───────────────────────────────────────────────────────────────────
  function handleHeaderClick(col: ColumnDef) {
    if (!col.sortable) return
    const newDir = sort.key === col.key && sort.dir === 'asc' ? 'desc' : 'asc'
    onSort(col.key, newDir)
  }

  // ── Inline save ────────────────────────────────────────────────────────────
  const handleCellSave = useCallback(
    async (contact: ContactSummary, field: string, newValue: string | null) => {
      const isCompanyField = field === 'primaryCompanyName'
      const patchValue = newValue === '' ? null : newValue

      // Company field requires non-empty value — silently revert if cleared
      if (isCompanyField && !patchValue) return

      const idsToUpdate =
        selectedIds.has(contact.id) && selectedIds.size > 1
          ? [...selectedIds]
          : [contact.id]

      // Capture originals BEFORE optimistic patch
      const originals = idsToUpdate.map((id) => {
        const c = contacts.find((ct) => ct.id === id)
        return { id, value: c ? c[field as keyof ContactSummary] : null }
      })

      // Optimistic patch — all affected rows immediately
      for (const { id } of originals) {
        onPatch(id, { [field]: patchValue })
      }

      const ipcCall = (id: string) =>
        isCompanyField
          ? api.invoke(IPC_CHANNELS.CONTACT_SET_COMPANY, id, patchValue as string)
          : api.invoke(IPC_CHANNELS.CONTACT_UPDATE, id, { [field]: patchValue })

      if (idsToUpdate.length === 1) {
        try {
          await ipcCall(contact.id)
        } catch {
          onPatch(contact.id, { [field]: originals[0].value })
        }
      } else {
        const originalsMap = new Map(originals.map((o) => [o.id, o.value]))
        const { failedIds } = await executeBulkEdit({
          ids: idsToUpdate,
          getOriginalValue: (id) => originalsMap.get(id) ?? null,
          updateFn: (id) => ipcCall(id),
          onPatch: (id, val) => onPatch(id, { [field]: val })
        })
        const succeededIds = idsToUpdate.filter((id) => !failedIds.includes(id))
        if (succeededIds.length > 0) {
          setUndoWithTimer({
            field,
            originals: originals.filter((o) => succeededIds.includes(o.id)),
            count: succeededIds.length
          })
        }
        if (failedIds.length > 0) {
          setBulkEditError(`${failedIds.length} of ${idsToUpdate.length} updates failed`)
        }
      }
    },
    [contacts, selectedIds, onPatch]
  )

  // ── TanStack Virtual ───────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: contacts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6
  })

  function scrollToRow(idx: number) {
    rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
  }
  // Wire scrollToRowRef so hooks defined above can call scrollToRow
  scrollToRowRef.current = scrollToRow

  const virtualRows = rowVirtualizer.getVirtualItems()

  // ── Render ─────────────────────────────────────────────────────────────────
  const applyDisabled =
    bulkEditValue === null ||
    (bulkEditField === 'company' && bulkEditValue.trim() === '')

  // Whether the currently-editing cell will trigger a bulk fill
  const bulkFillActive =
    editCell !== null &&
    selectedIds.size > 1 &&
    selectedIds.has(contacts[editCell.rowIdx]?.id ?? '')

  return (
    <>
      {bulkEditError && (
        <div className={styles.bulkErrorBanner}>
          {bulkEditError}
          <button onClick={() => setBulkEditError(null)}>✕</button>
        </div>
      )}
      {undoAction && (
        <div className={styles.undoToast}>
          Updated {undoAction.count} contact{undoAction.count !== 1 ? 's' : ''}
          <button className={styles.undoBtn} onClick={() => void handleUndo()}>
            Undo
          </button>
          <button
            className={styles.undoDismiss}
            onClick={() => { clearTimeout(undoTimerRef.current); setUndoAction(null) }}
          >
            ✕
          </button>
        </div>
      )}
      {bulkFillActive && (
        <div className={styles.bulkFillHint}>
          Editing will update {selectedIds.size} selected contacts
        </div>
      )}
      <div className={styles.tableWrapper} ref={scrollRef} tabIndex={0} onKeyDown={handleTableKeyDown}>
        {/* Header row */}
        <div className={styles.headerRow} style={{ gridTemplateColumns: gridCols }}>
          {/* Checkbox */}
          <div className={`${styles.headerCell} ${styles.checkboxCol} ${styles.checkboxCell}`}>
            <input
              type="checkbox"
              className={styles.checkboxInput}
              checked={selectedIds.size === contacts.length && contacts.length > 0}
              onChange={(e) => {
                lastSelectedIdxRef.current = null
                setSelectedIds(e.target.checked ? new Set(contacts.map((c) => c.id)) : new Set())
              }}
            />
          </div>

          {/* Column headers */}
          {mergedVisibleCols.map((col) => {
            const isName = col.key === 'name'
            const effectiveW = colWidths[col.key] ?? col.width
            const isSorted = sort.key === col.key
            const canPin = isPinnable(col)
            const isPinned = canPin && summaryKeys.includes(col.key)
            return (
              <div
                key={col.key}
                className={`${styles.headerCell} ${isName ? styles.nameCol : ''} ${col.sortable ? styles.sortable : ''} ${(col.options?.length || col.type === 'number' || col.type === 'date' || col.type === 'text') ? styles.filterableCell : ''} ${draggingKey === col.key ? styles.dragging : ''} ${dragOverKey === col.key ? styles.dragOver : ''}`}
                onClick={() => { if (renamingCol !== col.key) handleHeaderClick(col) }}
                onContextMenu={(e) => {
                  if (!onRenameColumn) return
                  e.preventDefault()
                  setRenamingCol(col.key)
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
              onSave={saveContactColumnConfig}
              onCreateField={onCreateField}
            />
          </div>
        </div>

        {/* Virtual body */}
        <div
          className={styles.virtualBody}
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {loading && contacts.length === 0 && (
            <div className={styles.emptyRow}>Loading…</div>
          )}
          {!loading && contacts.length === 0 && (
            <div className={styles.emptyRow}>No contacts found.</div>
          )}

          {virtualRows.map((vrow) => {
            const contact = contacts[vrow.index]
            if (!contact) return null
            const isSelected = selectedIds.has(contact.id)
            const isBulkFillTarget = bulkFillActive && isSelected

            return (
              <div
                key={contact.id}
                className={`${styles.dataRow} ${isSelected ? styles.selected : ''} ${isBulkFillTarget ? styles.pendingBulkFill : ''}`}
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
                    onChange={(e) => toggleSelect(contact.id, vrow.index, (e.nativeEvent as MouseEvent).shiftKey)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>

                {/* Name cell (sticky, navigates to contact detail) */}
                {visibleCols[0]?.key === 'name' && (
                  <div
                    className={`${styles.nameCol} ${styles.nameCell}`}
                    onClick={() => {
                      setEditCell(null)
                      navigate(`/contact/${contact.id}`)
                    }}
                  >
                    <span className={styles.nameText}>{contact.fullName}</span>
                  </div>
                )}

                {/* Remaining columns */}
                {mergedVisibleCols.slice(1).map((col, relIdx) => {
                  const colIdx = relIdx + 1
                  const isCellFocused = editCell?.rowIdx === vrow.index && editCell?.colIdx === colIdx
                  const fieldKey = col.field as keyof ContactSummary
                  const customFieldId = col.key.startsWith('custom:') ? col.key.slice(7) : null
                  const cellValue = customFieldId
                    ? (customFieldValues?.[contact.id]?.[customFieldId] ?? null)
                    : col.field ? (contact[fieldKey] as string | null) : null
                  const isCustomSelect = !!customFieldId && col.type === 'select'

                  if (isCustomSelect && !isCellFocused) {
                    return (
                      <div
                        key={col.key}
                        className={styles.chipCell}
                        onClick={() => handleStartEdit(vrow.index, colIdx)}
                      >
                        {cellValue ? (
                          <span className={styles.chip} style={chipStyle(cellValue)}>
                            {cellValue}
                          </span>
                        ) : null}
                      </div>
                    )
                  }

                  return (
                    <EditableCell
                      key={col.key}
                      value={cellValue}
                      col={col}
                      isFocused={isCellFocused}
                      onStartEdit={() => handleStartEdit(vrow.index, colIdx)}
                      onEndEdit={(dir) => handleEndEdit(vrow.index, colIdx, dir ?? null)}
                      onAddOption={
                        col.type === 'select'
                          ? async (newOption) => {
                              if (customFieldId) {
                                const def = useCustomFieldStore.getState().contactDefs.find(d => d.id === customFieldId)
                                await addCustomFieldOption(customFieldId, def?.optionsJson ?? null, newOption)
                              } else {
                                const builtinDef = useCustomFieldStore.getState().contactDefs.find(d => d.isBuiltin && d.fieldKey === col.key)
                                if (builtinDef) await addCustomFieldOption(builtinDef.id, builtinDef.optionsJson, newOption)
                              }
                            }
                          : undefined
                      }
                      onSave={async (newVal) => {
                        if (customFieldId) {
                          await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, {
                            fieldDefinitionId: customFieldId,
                            entityType: 'contact',
                            entityId: contact.id,
                            valueText: col.type === 'number' ? null : (newVal || null),
                            valueNumber: col.type === 'number' ? (newVal ? parseFloat(newVal) : null) : null,
                          })
                          onPatchCustomField?.(contact.id, customFieldId, newVal)
                        } else {
                          if (!col.field) return
                          await handleCellSave(contact, col.field, newVal)
                        }
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
                  {(['contactType', 'company'] as const).map((f) => (
                    <button
                      key={f}
                      className={`${styles.bulkEditTab} ${bulkEditField === f ? styles.bulkEditTabActive : ''}`}
                      onClick={() => { setBulkEditField(f); setBulkEditValue(null) }}
                    >
                      {f === 'contactType' ? 'Type' : 'Company'}
                    </button>
                  ))}
                </div>
                {/* Field body */}
                {bulkEditField === 'contactType' ? (
                  <div className={styles.bulkEditOptions}>
                    {[{ value: '', label: 'Clear' }, ...CONTACT_TYPES].map((o) => (
                      <label key={o.value} className={styles.bulkEditOption}>
                        <input
                          type="radio"
                          name="contactBulkType"
                          value={o.value}
                          checked={bulkEditValue === o.value}
                          onChange={() => setBulkEditValue(o.value)}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className={styles.bulkEditCompanyWrap}>
                    <input
                      className={styles.bulkEditCompanyInput}
                      placeholder="Company name…"
                      value={bulkEditValue ?? ''}
                      onChange={(e) => setBulkEditValue(e.target.value)}
                      autoFocus
                    />
                  </div>
                )}
                <div className={styles.bulkEditApply}>
                  <button
                    className={styles.bulkEditApplyBtn}
                    onClick={() => void handleBulkEdit()}
                    disabled={applyDisabled}
                  >
                    Apply to {selectedIds.size} contact{selectedIds.size !== 1 ? 's' : ''}
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
