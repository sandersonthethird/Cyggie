import { useEffect, useRef, useState } from 'react'
import { AddOptionInlineInput } from './AddOptionInlineInput'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { formatCurrency, formatDate } from '../../utils/format'
import { useDebounce } from '../../hooks/useDebounce'
import { EntitySearch } from './EntitySearch'
import { chipStyle } from '../../utils/colorChip'
import styles from './PropertyRow.module.css'
import { api } from '../../api'

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
  if (value == null || value === '') return '—'
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
  editMode = false
}: PropertyRowProps) {
  const [editing, setEditing] = useState(false)
  const [addingOption, setAddingOption] = useState(false)
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

  // Bail out of state updates if the component unmounts while a save is in-flight
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // Multiselect dropdown state
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [draftSelected, setDraftSelected] = useState<string[]>([])
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [search, setSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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

  // Auto-save for text/textarea/number with debounce
  useEffect(() => {
    if (!editing && !editMode) return
    if (type !== 'text' && type !== 'textarea' && type !== 'number' && type !== 'currency') return
    // Only trigger if value actually changed
    if (debouncedEdit === displayValue) return
    handleSave(debouncedEdit)
  }, [debouncedEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close multiselect dropdown when edit mode is deactivated
  useEffect(() => {
    if (!editMode && !editing && dropdownOpen) {
      closeAndSave()
    }
  }, [editMode, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  // Click-outside listener for multiselect dropdown
  useEffect(() => {
    if (!dropdownOpen) return
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeAndSave()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [dropdownOpen, draftSelected]) // eslint-disable-line react-hooks/exhaustive-deps

  function openDropdown(initialValue?: string | number | boolean | null) {
    const src = initialValue !== undefined ? initialValue : editValue
    const current = String(src ?? '').split(',').map(s => s.trim()).filter(Boolean)
    setDraftSelected(current)
    setFocusedIndex(-1)
    setSearch('')
    setDropdownOpen(true)
    setTimeout(() => (searchRef.current ?? dropdownRef.current)?.focus(), 0)
  }

  function closeAndSave() {
    setDropdownOpen(false)
    setSearch('')
    const joined = draftSelected.join(',') || null
    setEditValue(joined ?? '')
    handleSave(joined)
  }

  function startEdit() {
    if (readOnly || editMode) return
    setEditing(true)
    setEditValue(displayValue)
    setError(null)
    if (type === 'multiselect') {
      // Open dropdown immediately on click, seeding from displayValue (editValue not yet updated)
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

  async function handleSave(val: string | number | boolean | null) {
    if (saving) return
    const prev = displayValue
    const prevLabel = displayLabel
    // Optimistic update
    setDisplayValue(val)
    setSaving(true)
    setError(null)
    try {
      await onSave(val)
      setEditing(false)
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
        setTimeout(() => handleSave(editValueRef.current), 0)
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
    api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url).catch(console.error)
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
            rows={3}
          />
        )

      case 'select': {
        const parsedOpts = safeParseOptions(options)
        const optValues = parsedOpts.map(optionValue)

        if (addingOption) {
          return (
            <AddOptionInlineInput
              className={styles.input}
              onConfirm={async (opt) => {
                setAddingOption(false)
                try {
                  await onAddOption?.(opt)
                  handleSave(opt)
                } catch (e) {
                  console.error('[PropertyRow] addOption failed:', e)
                }
              }}
              onCancel={() => setAddingOption(false)}
            />
          )
        }

        return (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className={styles.select}
            value={String(editValue ?? '')}
            onChange={(e) => {
              if (e.target.value === '__add_option__') {
                setAddingOption(true)
                return
              }
              setEditValue(e.target.value)
              handleSave(e.target.value || null)
            }}
            onBlur={() => setEditing(false)}
          >
            <option value="">—</option>
            {parsedOpts.map((opt) => (
              <option key={optionValue(opt)} value={optionValue(opt)}>
                {optionLabel(opt)}
              </option>
            ))}
            {/* Stale value not in options */}
            {editValue && !optValues.includes(String(editValue)) && (
              <option value={String(editValue)} style={{ fontStyle: 'italic' }}>
                {String(editValue)} (unknown)
              </option>
            )}
            {onAddOption && (
              <option value="__add_option__">+ Add option...</option>
            )}
          </select>
        )
      }

      case 'multiselect': {
        const parsedOpts = safeParseOptions(options)
        const filteredOpts = search
          ? parsedOpts.filter(o => optionLabel(o).toLowerCase().includes(search.toLowerCase()))
          : parsedOpts

        if (addingOption) {
          return (
            <AddOptionInlineInput
              className={styles.input}
              onConfirm={async (opt) => {
                setAddingOption(false)
                try {
                  await onAddOption?.(opt)
                  const trimmed = opt.trim()
                  if (trimmed) {
                    const next = [...draftSelected, trimmed]
                    setDraftSelected(next)
                    const joined = next.join(',')
                    setEditValue(joined)
                    handleSave(joined)
                  }
                } catch (e) {
                  console.error('[PropertyRow] addOption failed:', e)
                }
              }}
              onCancel={() => setAddingOption(false)}
            />
          )
        }

        // Trigger — shown in both open and closed states
        // Uses draftSelected when open (buffered), editValue when closed (saved)
        const triggerChips = dropdownOpen
          ? draftSelected
          : String(editValue ?? '').split(',').map(s => s.trim()).filter(Boolean)

        const trigger = (
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
              : <span className={styles.empty}>—</span>
            }
            {!readOnly && <span className={styles.multiselectCaret}>{dropdownOpen ? '▴' : '▾'}</span>}
          </div>
        )

        if (!dropdownOpen) return trigger

        return (
          <div className={styles.multiselectWrapper}>
            {trigger}
            <div
              ref={dropdownRef}
              className={styles.multiselectDropdown}
              role="listbox"
              aria-multiselectable={true}
              tabIndex={-1}
              onKeyDown={(e) => {
                const opts = filteredOpts
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setFocusedIndex(i => opts.length === 0 ? -1 : (i + 1) % opts.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setFocusedIndex(i => opts.length === 0 ? -1 : (i - 1 + opts.length) % opts.length)
                } else if (e.key === ' ' && focusedIndex >= 0 && focusedIndex < opts.length) {
                  e.preventDefault()
                  const val = optionValue(opts[focusedIndex])
                  setDraftSelected(prev =>
                    prev.includes(val) ? prev.filter(s => s !== val) : [...prev, val]
                  )
                } else if (e.key === 'Escape' || e.key === 'Enter') {
                  e.preventDefault()
                  closeAndSave()
                }
              }}
            >
              {/* Search input — only when 5+ options */}
              {parsedOpts.length >= 5 && (
                <input
                  ref={searchRef}
                  className={styles.multiselectSearch}
                  placeholder="Search..."
                  value={search}
                  onChange={e => { setSearch(e.target.value); setFocusedIndex(-1) }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { e.stopPropagation(); closeAndSave() }
                  }}
                  aria-label="Search options"
                />
              )}

              {/* Clear all */}
              {draftSelected.length > 0 && (
                <button
                  type="button"
                  className={styles.multiselectClearAll}
                  onMouseDown={e => { e.preventDefault(); setDraftSelected([]) }}
                >
                  Clear all
                </button>
              )}

              {/* Options */}
              {filteredOpts.length === 0 && (
                <div className={styles.multiselectEmpty}>No options match</div>
              )}
              {filteredOpts.map((opt, i) => {
                const val = optionValue(opt)
                const isSelected = draftSelected.includes(val)
                return (
                  <div
                    key={val}
                    className={`${styles.multiselectOption} ${i === focusedIndex ? styles.multiselectOptionFocused : ''}`}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={e => {
                      e.preventDefault()
                      setDraftSelected(prev =>
                        prev.includes(val) ? prev.filter(s => s !== val) : [...prev, val]
                      )
                    }}
                    onMouseEnter={() => setFocusedIndex(i)}
                  >
                    <span className={isSelected ? styles.checkboxChecked : styles.checkboxUnchecked}>
                      {isSelected ? '☑' : '☐'}
                    </span>
                    <span style={isSelected ? chipStyle(val) : undefined}>{optionLabel(opt)}</span>
                  </div>
                )
              })}

              {/* Add option */}
              {onAddOption && (
                <button
                  type="button"
                  className={styles.addOptionLink}
                  onMouseDown={e => { e.preventDefault(); setAddingOption(true); setDropdownOpen(false) }}
                >
                  + Add option
                </button>
              )}
            </div>
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
      if (tags.length === 0) return <span className={styles.empty}>—</span>
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
      if (!url) return <span className={styles.empty}>—</span>
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
      if (!displayValue) return <span className={styles.empty}>—</span>
      return <span>{displayLabel || String(displayValue)}</span>
    }

    if (type === 'multiselect' && displayValue) {
      const vals = String(displayValue).split(',').map(s => s.trim()).filter(Boolean)
      if (vals.length === 0) return <span className={styles.empty}>—</span>
      return (
        <span className={styles.chips}>
          {vals.map(v => (
            <span key={v} className={styles.chip} style={chipStyle(v)}>{v}</span>
          ))}
        </span>
      )
    }

    if (type === 'select' && displayValue) {
      const strVal = String(displayValue)
      return <span className={styles.chip} style={chipStyle(strVal)}>{strVal}</span>
    }

    const formatted = formatValue(displayValue, type, displayLabel)
    if (formatted === '—') return <span className={styles.empty}>—</span>
    return <span>{formatted}</span>
  }

  return (
    <div className={`${styles.row} ${isActive ? styles.editing : ''}`} onClick={!isActive && !readOnly ? startEdit : undefined}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {isActive ? renderEditor() : renderDisplay()}
        {saving && <span className={styles.saving}>…</span>}
        {error && <span className={styles.error} title={error}>!</span>}
      </span>
    </div>
  )
}
