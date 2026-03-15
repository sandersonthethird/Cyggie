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
import { executeBulkEdit } from '../crm/tableUtils'
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
}

export function ContactTable({
  contacts,
  loading,
  sort,
  onSort,
  onPatch,
  onBulkDelete,
  visibleKeys,
  onVisibleKeysChange
}: ContactTableProps) {
  const navigate = useNavigate()
  const { getJSON, setJSON } = usePreferencesStore()
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
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => loadContactColumnWidths())

  const visibleCols = useMemo<ColumnDef[]>(
    () => visibleKeys.flatMap((k) => CONTACT_COLUMN_DEFS.find((c) => c.key === k) ?? []),
    [visibleKeys]
  )

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
  const [bulkEditField, setBulkEditField] = useState<'contactType' | 'company'>('contactType')
  const [bulkEditValue, setBulkEditValue] = useState<string | null>(null)
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
          const item = contacts[i]
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
      if (nextRow < contacts.length) {
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
        saveContactColumnWidths(prev)
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
    async (contact: ContactSummary, field: string, newValue: string | null) => {
      const patch: Record<string, unknown> = { [field]: newValue === '' ? null : newValue }
      await api.invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, patch)
      onPatch(contact.id, patch)
    },
    [onPatch]
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

  const virtualRows = rowVirtualizer.getVirtualItems()

  // ── Render ─────────────────────────────────────────────────────────────────
  const applyDisabled =
    bulkEditValue === null ||
    (bulkEditField === 'company' && bulkEditValue.trim() === '')

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
              checked={selectedIds.size === contacts.length && contacts.length > 0}
              onChange={(e) => {
                lastSelectedIdxRef.current = null
                setSelectedIds(e.target.checked ? new Set(contacts.map((c) => c.id)) : new Set())
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
              allDefs={CONTACT_COLUMN_DEFS}
              onChange={onVisibleKeysChange}
              onSave={saveContactColumnConfig}
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
            const isSelected = selectedIds.has(contact.id)

            return (
              <div
                key={contact.id}
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

                {/* Remaining columns — company name navigates, others are editable */}
                {visibleCols.slice(1).map((col, relIdx) => {
                  const colIdx = relIdx + 1
                  const isCellFocused = editCell?.rowIdx === vrow.index && editCell?.colIdx === colIdx

                  // Company column: click navigates to company detail
                  if (col.key === 'primaryCompanyName') {
                    return (
                      <div
                        key={col.key}
                        className={styles.companyCell}
                        onClick={() => {
                          if (contact.primaryCompanyId) {
                            navigate(`/company/${contact.primaryCompanyId}`)
                          }
                        }}
                      >
                        {contact.primaryCompanyName
                          ? <span className={`${styles.companyCellText} ${contact.primaryCompanyId ? styles.companyCellLink : ''}`}>{contact.primaryCompanyName}</span>
                          : <span className={styles.cellEmpty}>—</span>
                        }
                      </div>
                    )
                  }

                  const fieldKey = col.field as keyof ContactSummary
                  return (
                    <EditableCell
                      key={col.key}
                      value={col.field ? contact[fieldKey] : null}
                      col={col}
                      isFocused={isCellFocused}
                      onStartEdit={() => handleStartEdit(vrow.index, colIdx)}
                      onEndEdit={(dir) => handleEndEdit(vrow.index, colIdx, dir ?? null)}
                      onSave={async (newVal) => {
                        if (!col.field) return
                        await handleCellSave(contact, col.field, newVal)
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
