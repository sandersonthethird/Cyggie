import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OptionListPopover } from './OptionListPopover'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { formatCurrency, formatDate } from '../../utils/format'
import { useDebounce } from '../../hooks/useDebounce'
import { EntitySearch } from './EntitySearch'
import { chipStyle } from '../../utils/colorChip'
import { parseMultiselectValue } from '../../../shared/custom-field-values'
import styles from './PropertyRow.module.css'
import { api } from '../../api'

const EMPTY_DISPLAY = '+ Add'

export type PropertyRowType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'date'
  | 'url'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'tags'
  | 'contact_ref'
  | 'company_ref'

export type PropertyRowOption = string | { value: string; label: string }

function optionValue(o: PropertyRowOption): string {
  return typeof o === 'string' ? o : o.value
}

function optionLabel(o: PropertyRowOption): string {
  return typeof o === 'string' ? o : o.label
}

interface PropertyRowProps {
  label: string
  value: string | number | boolean | null
  type: PropertyRowType
  options?: PropertyRowOption[]
  placeholder?: string
  resolvedLabel?: string | null
  onSave: (newValue: string | number | boolean | null) => Promise<void>
  onAddOption?: (newOption: string) => Promise<void>
  readOnly?: boolean
  editMode?: boolean // When true, always renders in edit state (driven by parent)
  icon?: ReactNode // Optional leading icon rendered to the left of the label
}

function safeParseTags(value: string | number | boolean | null): string[] {
  if (!value && value !== 0) return []
  return String(value)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function safeParseOptions(opts: PropertyRowOption[] | undefined): PropertyRowOption[] {
  if (!opts) return []
  return opts
}

function formatValue(
  value: string | number | boolean | null,
  type: PropertyRowType,
  resolvedLabel?: string | null
): string {
  if (value == null || value === '') return EMPTY_DISPLAY
  switch (type) {
    case 'currency':
      return formatCurrency(Number(value))
    case 'date':
      return formatDate(String(value))
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'contact_ref':
    case 'company_ref':
      return resolvedLabel || String(value)
    default:
      return String(value)
  }
}

export function PropertyRow({
  label,
  value,
  type,
  options,
  placeholder,
  resolvedLabel,
  onSave,
  onAddOption,
  readOnly = false,
  editMode = false,
  icon
}: PropertyRowProps) {
  const [editing, setEditing] = useState(false)
  const isActive = editing || editMode
  const [editValue, setEditValue] = useState<string | number | boolean | null>(value)
  const [displayValue, setDisplayValue] = useState<string | number | boolean | null>(value)
  const [displayLabel, setDisplayLabel] = useState<string | null>(resolvedLabel ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  // Mirror editValue synchronously so the finally block can detect pending changes
  // after an in-flight IPC save completes (Bug #2: prevents silent data loss on fast edits)
  const editValueRef = useRef<string | number | boolean | null>(value)
  useEffect(() => { editValueRef.current = editValue }, [editValue])

  // Mirror displayValue synchronously for the unmount flush below
  const displayValueRef = useRef<string | number | boolean | null>(value)
  useEffect(() => { displayValueRef.current = displayValue }, [displayValue])

  // Keep a stable ref to onSave so the unmount cleanup always calls the latest version
  const onSaveRef = useRef(onSave)
  useEffect(() => { onSaveRef.current = onSave }, [onSave])

  // Bail out of state updates if the component unmounts while a save is in-flight
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // Flush unsaved changes on unmount — handles components (e.g. Website URL) that are
  // conditionally rendered and get fully removed from the DOM when the edit panel closes,
  // before any in-flight debounced save or IPC re-trigger can complete.
  useEffect(() => {
    return () => {
      if (type !== 'text' && type !== 'textarea' && type !== 'url') return
      if (editValueRef.current !== displayValueRef.current) {
        void onSaveRef.current(editValueRef.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Multiselect / single-select dropdown state — popover open + accumulated multi selection.
  // OptionListPopover owns its own keyboard nav, outside-click, type-jump
  // accumulator, and "+ Add option" inline-input swap. PropertyRow only
  // tracks: (a) whether the popover is open, (b) the draft multi-selection
  // accumulator (committed on close), and (c) the anchor for positioning.
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [draftSelected, setDraftSelected] = useState<string[]>([])
  const valueRef = useRef<HTMLSpanElement>(null)

  const parsedOptionsForPopover = useMemo(
    () => safeParseOptions(options).map(o => ({
      value: optionValue(o),
      label: optionLabel(o),
    })),
    [options]
  )

  const debouncedEdit = useDebounce(editValue, 300)

  // Sync external value changes — only when the prop value changes from outside.
  // Intentionally excludes `editing` and `editMode` from deps: when editMode transitions
  // from true→false (user clicks "Done"), we must NOT reset displayValue to the stale prop
  // while an async IPC save from closeAndSave() is still in flight.
  useEffect(() => {
    if (!editing && !editMode) {
      setDisplayValue(value)
      setEditValue(value)
      setDisplayLabel(resolvedLabel ?? null)
    }
  }, [value, resolvedLabel]) // eslint-disable-line react-hooks/exhaustive-deps

  // When editMode first activates, prime editValue from the current display value
  useEffect(() => {
    if (editMode) {
      setEditValue(displayValue)
    }
  }, [editMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save for text/textarea/url with debounce
  useEffect(() => {
    if (!editing && !editMode) return
    if (type !== 'text' && type !== 'textarea' && type !== 'url') return
    // Only trigger if value actually changed
    if (debouncedEdit === displayValue) return
    handleSave(debouncedEdit, true)  // keep editing open while user types
  }, [debouncedEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close popover when edit mode is deactivated externally
  useEffect(() => {
    if (!editMode && !editing && dropdownOpen) {
      closeAndSave()
    }
  }, [editMode, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  // OptionListPopover owns its own outside-click handling — no document listener needed here.

  function openDropdown(initialValue?: string | number | boolean | null) {
    const src = initialValue !== undefined ? initialValue : editValue
    // Tolerate legacy JSON-array values so their options match the popover checkboxes.
    const current = parseMultiselectValue(src)
    setDraftSelected(current)
    setDropdownOpen(true)
  }

  function closeAndSave() {
    setDropdownOpen(false)
    const joined = draftSelected.join(',') || null
    setEditValue(joined ?? '')
    handleSave(joined)
  }

  function startEdit() {
    if (readOnly || editMode) return
    setEditing(true)
    setEditValue(displayValue)
    setError(null)
    if (type === 'multiselect' || type === 'select') {
      // Open OptionListPopover immediately, seeding from displayValue
      // (editValue not yet updated synchronously). Single-select gets its
      // popover via the same path; the old <select> opened natively on click.
      setTimeout(() => openDropdown(displayValue), 0)
    } else {
      setTimeout(() => (inputRef.current as HTMLElement | null)?.focus(), 0)
    }
  }

  function cancelEdit() {
    setEditing(false)
    setEditValue(displayValue)
    setError(null)
  }

  async function handleSave(val: string | number | boolean | null, keepEditing = false) {
    if (saving) return
    const prev = displayValue
    const prevLabel = displayLabel
    // Optimistic update
    setDisplayValue(val)
    setSaving(true)
    setError(null)
    try {
      await onSave(val)
      if (!keepEditing) setEditing(false)
    } catch (e) {
      setDisplayValue(prev)
      setDisplayLabel(prevLabel)
      const msg = e instanceof Error ? e.message : 'Save failed'
      setError(msg)
      console.error('[PropertyRow] save failed:', e)
    } finally {
      if (!mountedRef.current) return
      const hadPendingChange = editValueRef.current !== val
      setSaving(false)
      // If editValue changed while IPC was in-flight, re-trigger save to avoid data loss
      if (hadPendingChange && (editing || editMode)) {
        console.warn('[PropertyRow] re-triggering save: value changed during IPC')
        setTimeout(() => handleSave(editValueRef.current, true), 0)
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') cancelEdit()
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault()
      handleSave(editValue)
    }
  }

  function handleBlur() {
    if (type === 'text' || type === 'textarea' || type === 'number' || type === 'currency') {
      handleSave(editValue)
    } else if (type !== 'select' && type !== 'multiselect' && type !== 'boolean' && type !== 'tags') {
      handleSave(editValue)
    }
    if (!editMode) setEditing(false)
  }

  function openExternalUrl(url: string) {
    if (!url) return
    // Prepend https:// if user saved a bare domain (e.g. "www.example.com")
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, normalized).catch(console.error)
  }

  // ── Render edit controls ──

  function renderEditor() {
    switch (type) {
      case 'textarea':
        return (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className={styles.textarea}
            value={String(editValue ?? '')}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={placeholder}
            rows={3}
          />
        )

      case 'select': {
        // Render the current value as a chip trigger; the OptionListPopover
        // floats below via a portal (anchored to valueRef in the outer return).
        const strVal = String(editValue ?? '')
        const opt = parsedOptionsForPopover.find(o => o.value === strVal)
        const label = opt?.label ?? strVal
        return (
          <span
            className={strVal ? styles.chip : styles.empty}
            style={strVal ? chipStyle(strVal) : undefined}
            onClick={() => !dropdownOpen && openDropdown(displayValue)}
          >
            {strVal ? label : EMPTY_DISPLAY}
          </span>
        )
      }

      case 'multiselect': {
        // Render the chip cluster as the trigger; OptionListPopover floats below
        // via a portal (anchored to valueRef in the outer return).
        // While open, show the draft (in-progress) selection; while closed, show saved.
        const triggerChips = dropdownOpen
          ? draftSelected
          : String(editValue ?? '').split(',').map(s => s.trim()).filter(Boolean)
        return (
          <div
            className={styles.multiselectTrigger}
            onClick={() => !readOnly && !dropdownOpen && openDropdown()}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={dropdownOpen}
          >
            {triggerChips.length > 0
              ? triggerChips.map(v => (
                  <span key={v} className={styles.chip} style={chipStyle(v)}>{v}</span>
                ))
              : <span className={styles.empty}>{EMPTY_DISPLAY}</span>
            }
            {!readOnly && <span className={styles.multiselectCaret}>{dropdownOpen ? '▴' : '▾'}</span>}
          </div>
        )
      }

      case 'boolean':
        return (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className={styles.select}
            value={editValue === true ? 'true' : editValue === false ? 'false' : ''}
            onChange={(e) => {
              const val = e.target.value === 'true' ? true : e.target.value === 'false' ? false : null
              setEditValue(val)
              handleSave(val)
            }}
            onBlur={() => setEditing(false)}
          >
            <option value="">—</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        )

      case 'date':
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="date"
            className={styles.input}
            value={String(editValue ?? '')}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => handleSave(editValue)}
            onKeyDown={handleKeyDown}
          />
        )

      case 'number':
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="number"
            className={styles.input}
            value={editValue != null ? String(editValue) : ''}
            onChange={(e) => setEditValue(e.target.value ? Number(e.target.value) : null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        )

      case 'currency':
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="number"
            className={styles.input}
            placeholder="0"
            value={editValue != null ? String(editValue) : ''}
            onChange={(e) => setEditValue(e.target.value ? Number(e.target.value) : null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        )

      case 'tags':
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className={styles.input}
            value={String(editValue ?? '')}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => handleSave(editValue)}
            onKeyDown={handleKeyDown}
            placeholder="comma-separated tags"
          />
        )

      case 'contact_ref':
        return (
          <EntitySearch
            entityType="contact"
            onSelect={(id, label) => {
              setDisplayLabel(label)
              handleSave(id)
            }}
            placeholder="Search contacts…"
          />
        )

      case 'company_ref':
        return (
          <EntitySearch
            entityType="company"
            onSelect={(id, label) => {
              setDisplayLabel(label)
              handleSave(id)
            }}
            placeholder="Search companies…"
          />
        )

      case 'url':
      case 'text':
      default:
        return (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className={styles.input}
            value={String(editValue ?? '')}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? '—'}
          />
        )
    }
  }

  // ── Render view ──

  function renderDisplay() {
    if (type === 'tags') {
      const tags = safeParseTags(displayValue)
      if (tags.length === 0) return <span className={styles.empty}>{EMPTY_DISPLAY}</span>
      return (
        <span className={styles.tags}>
          {tags.map((tag) => (
            <span key={tag} className={styles.tag}>{tag}</span>
          ))}
        </span>
      )
    }

    if (type === 'url') {
      const url = String(displayValue ?? '')
      if (!url) return <span className={styles.empty}>{EMPTY_DISPLAY}</span>
      return (
        <a
          className={styles.link}
          onClick={() => openExternalUrl(url)}
          title={url}
        >
          {url.replace(/^https?:\/\//, '')}
        </a>
      )
    }

    if (type === 'contact_ref' || type === 'company_ref') {
      if (!displayValue) return <span className={styles.empty}>{EMPTY_DISPLAY}</span>
      return <span>{displayLabel || String(displayValue)}</span>
    }

    if (type === 'multiselect' && displayValue) {
      const parsedOpts = safeParseOptions(options)
      const vals = parseMultiselectValue(displayValue)
      if (vals.length === 0) return <span className={styles.empty}>{EMPTY_DISPLAY}</span>
      return (
        <span className={styles.chips}>
          {vals.map(v => {
            const opt = parsedOpts.find(o => optionValue(o) === v)
            const label = opt ? optionLabel(opt) : v
            return <span key={v} className={styles.chip} style={chipStyle(v)}>{label}</span>
          })}
        </span>
      )
    }

    if (type === 'select' && displayValue) {
      const strVal = String(displayValue)
      const parsedOpts = safeParseOptions(options)
      const opt = parsedOpts.find(o => optionValue(o) === strVal)
      const label = opt ? optionLabel(opt) : strVal
      return <span className={styles.chip} style={chipStyle(strVal)}>{label}</span>
    }

    const formatted = formatValue(displayValue, type, displayLabel)
    if (formatted === EMPTY_DISPLAY) return <span className={styles.empty}>{EMPTY_DISPLAY}</span>
    return <span>{formatted}</span>
  }

  // ── Shared popover for select / multiselect ──
  // Anchored to the value cell so the menu appears below the chip cluster.
  const renderPopover = () => {
    if (!isActive || !dropdownOpen) return null
    if (type === 'select') {
      return (
        <OptionListPopover
          anchorEl={valueRef.current}
          options={parsedOptionsForPopover}
          value={String(editValue ?? '')}
          mode="single"
          onPick={(v) => {
            setEditValue(v)
            setDropdownOpen(false)
            handleSave(v || null)
          }}
          onAddOption={onAddOption ? () => { /* popover swaps body internally */ } : undefined}
          onAddOptionConfirm={async (opt) => {
            try {
              await onAddOption?.(opt)
              setDropdownOpen(false)
              setEditValue(opt)
              handleSave(opt)
            } catch (e) {
              console.error('[PropertyRow] addOption failed:', e)
              setDropdownOpen(false)
            }
          }}
          onClose={() => {
            setDropdownOpen(false)
            if (!editMode) setEditing(false)
          }}
          chipStyle={chipStyle}
        />
      )
    }
    if (type === 'multiselect') {
      return (
        <OptionListPopover
          anchorEl={valueRef.current}
          options={parsedOptionsForPopover}
          value={draftSelected}
          mode="multi"
          onMultiChange={setDraftSelected}
          onCommitMulti={closeAndSave}
          onAddOption={onAddOption ? () => { /* popover swaps body internally */ } : undefined}
          onAddOptionConfirm={async (opt) => {
            try {
              await onAddOption?.(opt)
              const trimmed = opt.trim()
              if (trimmed) {
                const next = [...draftSelected, trimmed]
                setDraftSelected(next)
                const joined = next.join(',')
                setEditValue(joined)
                setDropdownOpen(false)
                handleSave(joined)
              }
            } catch (e) {
              console.error('[PropertyRow] addOption failed:', e)
              setDropdownOpen(false)
            }
          }}
          onClose={() => { /* commit handled by onCommitMulti */ }}
          chipStyle={chipStyle}
        />
      )
    }
    return null
  }

  return (
    <div className={`${styles.row} ${isActive ? styles.editing : ''}`} onClick={!isActive && !readOnly ? startEdit : undefined}>
      <span className={`${styles.label} ${icon ? styles.labelWithIcon : ''}`}>
        {icon && <span className={styles.labelIcon} aria-hidden>{icon}</span>}
        <span className={styles.labelText}>{label}</span>
      </span>
      <span ref={valueRef} className={styles.value}>
        {isActive ? renderEditor() : renderDisplay()}
        {isActive && saving && <span className={styles.saving}>…</span>}
        {error && <span className={styles.error} title={error}>!</span>}
        {renderPopover()}
      </span>
    </div>
  )
}
