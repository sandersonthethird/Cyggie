import { useState } from 'react'
import { AddOptionInlineInput } from './AddOptionInlineInput'

type DataAttrs = { [K in `data-${string}`]?: string }

interface ChipSelectProps extends DataAttrs {
  value: string | null | undefined
  options: { value: string; label: string }[]
  isEditing: boolean
  onSave: (value: string | null) => void
  className?: string
  allowEmpty?: boolean
  onAddOption?: (value: string) => Promise<void>
  /** Surfaces add-option failures (rejected IPC, validation errors). Optional. */
  onError?: (message: string) => void
  /**
   * 'inline' (default) renders a span or a <select> based on isEditing — used inside
   * properties panels in their edit mode.
   * 'cell' renders an always-interactive chip cell with a caret and an invisible-overlay
   * <select>, used in tables (e.g. Pipeline). isEditing is ignored in this variant.
   */
  variant?: 'inline' | 'cell'
  /** className applied to the overlay <select> in cell variant. */
  cellSelectClassName?: string
  /** className applied to the caret span in cell variant. */
  cellCaretClassName?: string
}

export function ChipSelect({
  value,
  options,
  isEditing,
  onSave,
  className,
  allowEmpty = false,
  onAddOption,
  onError,
  variant = 'inline',
  cellSelectClassName,
  cellCaretClassName,
  ...dataAttrs
}: ChipSelectProps) {
  const [addingOption, setAddingOption] = useState(false)
  const label = options.find((o) => o.value === value)?.label ?? value ?? '—'

  const handleConfirm = async (opt: string) => {
    setAddingOption(false)
    try {
      await onAddOption!(opt)
      onSave(opt)
    } catch (e) {
      console.warn('[ChipSelect] add-option flow failed:', e)
      onError?.(e instanceof Error ? e.message : 'Failed to save option')
    }
  }

  if (variant === 'cell') {
    if (addingOption && onAddOption) {
      return (
        <AddOptionInlineInput
          className={className ?? ''}
          onConfirm={handleConfirm}
          onCancel={() => setAddingOption(false)}
        />
      )
    }
    return (
      <div className={className} {...dataAttrs}>
        <span>{label}</span>
        <span className={cellCaretClassName}>▾</span>
        <select
          className={cellSelectClassName}
          value={value ?? ''}
          onChange={(e) => {
            if (e.target.value === '__add_option__') {
              setAddingOption(true)
              return
            }
            onSave(e.target.value || null)
          }}
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {onAddOption && <option value="__add_option__">+ Add option…</option>}
        </select>
      </div>
    )
  }

  // inline variant (existing behavior)
  if (!isEditing) {
    if (!value) return null
    return <span className={className} {...dataAttrs}>{label}</span>
  }

  if (addingOption && onAddOption) {
    return (
      <AddOptionInlineInput
        className={className ?? ''}
        onConfirm={handleConfirm}
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
      {...dataAttrs}
    >
      {allowEmpty && <option value="">—</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
      {onAddOption && <option value="__add_option__">+ Add option…</option>}
    </select>
  )
}
