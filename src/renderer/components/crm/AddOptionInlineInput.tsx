import { useState } from 'react'

interface AddOptionInlineInputProps {
  className: string
  onConfirm: (opt: string) => Promise<void>
  onCancel: () => void
}

export function AddOptionInlineInput({ className, onConfirm, onCancel }: AddOptionInlineInputProps) {
  const [draft, setDraft] = useState('')

  return (
    <input
      className={className}
      placeholder="New option…"
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={async (e) => {
        if (e.key === 'Escape') { onCancel(); return }
        if (e.key === 'Enter' && draft.trim()) {
          e.preventDefault()
          await onConfirm(draft)
          setDraft('')
        }
      }}
      onBlur={onCancel}
    />
  )
}
