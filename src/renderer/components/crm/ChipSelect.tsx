import { useState } from 'react'
import { AddOptionInlineInput } from './AddOptionInlineInput'

interface ChipSelectProps {
  value: string | null | undefined
  options: { value: string; label: string }[]
  isEditing: boolean
  onSave: (value: string | null) => void
  className?: string
  allowEmpty?: boolean
  onAddOption?: (value: string) => Promise<void>
}

export function ChipSelect({ value, options, isEditing, onSave, className, allowEmpty = false, onAddOption }: ChipSelectProps) {
  const [addingOption, setAddingOption] = useState(false)
  const label = options.find((o) => o.value === value)?.label ?? value ?? '—'

  if (!isEditing) {
    if (!value) return null
    return <span className={className}>{label}</span>
  }

  if (addingOption && onAddOption) {
    return (
      <AddOptionInlineInput
        className={className ?? ''}
        onConfirm={async (opt) => {
          setAddingOption(false)
          await onAddOption(opt)
          onSave(opt)
        }}
        onCancel={() => setAddingOption(false)}
      />
    )
  }

  return (
    <select
      className={className}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__add_option__') {
          setAddingOption(true)
          return
        }
        onSave(e.target.value || null)
      }}
    >
      {allowEmpty && <option value="">—</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
      {onAddOption && <option value="__add_option__">+ Add option…</option>}
    </select>
  )
}
