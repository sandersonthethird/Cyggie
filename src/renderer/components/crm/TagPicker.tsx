import { useState } from 'react'
import { AddOptionInlineInput } from './AddOptionInlineInput'

/**
 * Multi-select picker for canonical-vocabulary fields. Stored value is a
 * comma-separated CSV string (e.g. "FinTech,InsurTech"). Used for fields
 * like contacts.investment_sector_focus.
 */
interface TagPickerProps {
  /** Comma-separated CSV string of selected values, or null. */
  value: string | null | undefined
  options: { value: string; label: string }[]
  isEditing: boolean
  onSave: (value: string | null) => void
  className?: string
  onAddOption?: (value: string) => Promise<void>
}

function parseCsv(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

function joinCsv(values: string[]): string | null {
  const cleaned = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)))
  return cleaned.length > 0 ? cleaned.join(',') : null
}

export function TagPicker({ value, options, isEditing, onSave, className, onAddOption }: TagPickerProps) {
  const [addingOption, setAddingOption] = useState(false)
  const selected = parseCsv(value)
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v

  if (!isEditing) {
    if (selected.length === 0) return null
    return (
      <span className={className}>
        {selected.map((v) => labelFor(v)).join(', ')}
      </span>
    )
  }

  if (addingOption && onAddOption) {
    return (
      <AddOptionInlineInput
        className={className ?? ''}
        onConfirm={async (opt) => {
          setAddingOption(false)
          await onAddOption(opt)
          if (!selected.includes(opt)) {
            onSave(joinCsv([...selected, opt]))
          }
        }}
        onCancel={() => setAddingOption(false)}
      />
    )
  }

  const remaining = options.filter((o) => !selected.includes(o.value))

  return (
    <span className={className}>
      {selected.map((v) => (
        <span key={v} style={{ display: 'inline-block', padding: '2px 6px', margin: '0 4px 4px 0', background: 'var(--bg-subtle, #eef)', borderRadius: 4 }}>
          {labelFor(v)}
          <button
            type="button"
            onClick={() => onSave(joinCsv(selected.filter((s) => s !== v)))}
            style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            aria-label={`Remove ${labelFor(v)}`}
          >
            ×
          </button>
        </span>
      ))}
      {(remaining.length > 0 || onAddOption) && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value === '__add_option__') {
              setAddingOption(true)
              return
            }
            if (e.target.value) {
              onSave(joinCsv([...selected, e.target.value]))
            }
          }}
        >
          <option value="">+ Add…</option>
          {remaining.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {onAddOption && <option value="__add_option__">+ Add option…</option>}
        </select>
      )}
    </span>
  )
}
