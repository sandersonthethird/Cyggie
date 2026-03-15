interface ChipSelectProps {
  value: string | null | undefined
  options: { value: string; label: string }[]
  isEditing: boolean
  onSave: (value: string | null) => void
  className?: string
  allowEmpty?: boolean
}

export function ChipSelect({ value, options, isEditing, onSave, className, allowEmpty = false }: ChipSelectProps) {
  const label = options.find((o) => o.value === value)?.label ?? value ?? '—'

  if (!isEditing) {
    if (!value) return null
    return <span className={className}>{label}</span>
  }

  return (
    <select
      className={className}
      value={value ?? ''}
      onChange={(e) => onSave(e.target.value || null)}
    >
      {allowEmpty && <option value="">—</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
