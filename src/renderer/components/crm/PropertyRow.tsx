import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { formatCurrency, formatDate } from '../../utils/format'
import { useDebounce } from '../../hooks/useDebounce'
import { EntitySearch } from './EntitySearch'
import styles from './PropertyRow.module.css'

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

interface PropertyRowProps {
  label: string
  value: string | number | boolean | null
  type: PropertyRowType
  options?: string[]
  placeholder?: string
  resolvedLabel?: string | null
  onSave: (newValue: string | number | boolean | null) => Promise<void>
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

function safeParseOptions(optionsJson: string[] | undefined): string[] {
  if (!optionsJson) return []
  return optionsJson
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
  readOnly = false,
  editMode = false
}: PropertyRowProps) {
  const [editing, setEditing] = useState(false)
  const isActive = editing || editMode
  const [editValue, setEditValue] = useState<string | number | boolean | null>(value)
  const [displayValue, setDisplayValue] = useState<string | number | boolean | null>(value)
  const [displayLabel, setDisplayLabel] = useState<string | null>(resolvedLabel ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  const debouncedEdit = useDebounce(editValue, 300)

  // Sync external value changes (only when not in any edit state)
  useEffect(() => {
    if (!editing && !editMode) {
      setDisplayValue(value)
      setEditValue(value)
      setDisplayLabel(resolvedLabel ?? null)
    }
  }, [value, resolvedLabel, editing, editMode])

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

  function startEdit() {
    if (readOnly || editMode) return
    setEditing(true)
    setEditValue(displayValue)
    setError(null)
    setTimeout(() => (inputRef.current as HTMLElement | null)?.focus(), 0)
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
      setSaving(false)
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
    window.api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url).catch(console.error)
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

      case 'select':
        return (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className={styles.select}
            value={String(editValue ?? '')}
            onChange={(e) => {
              setEditValue(e.target.value)
              handleSave(e.target.value || null)
            }}
            onBlur={() => setEditing(false)}
          >
            <option value="">—</option>
            {safeParseOptions(options).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
            {/* Stale value not in options */}
            {editValue && !safeParseOptions(options).includes(String(editValue)) && (
              <option value={String(editValue)} style={{ fontStyle: 'italic' }}>
                {String(editValue)} (unknown)
              </option>
            )}
          </select>
        )

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
          {url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
        </a>
      )
    }

    if (type === 'contact_ref' || type === 'company_ref') {
      if (!displayValue) return <span className={styles.empty}>—</span>
      return <span>{displayLabel || String(displayValue)}</span>
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
