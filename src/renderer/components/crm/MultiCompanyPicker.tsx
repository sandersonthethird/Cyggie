import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { usePicker } from '../../hooks/usePicker'
import { EntityPicker } from '../common/EntityPicker'
import styles from './MultiCompanyPicker.module.css'
import type { CompanySummary } from '../../../shared/types/company'

interface MultiCompanyPickerProps {
  value: Array<{ id: string; name: string }>
  onChange: (value: Array<{ id: string; name: string }>) => void
  readOnly?: boolean
}

export function MultiCompanyPicker({ value, onChange, readOnly = false }: MultiCompanyPickerProps) {
  const navigate = useNavigate()
  const [showPicker, setShowPicker] = useState(false)
  const picker = usePicker<CompanySummary>(IPC_CHANNELS.COMPANY_LIST, 20, { view: 'all' })

  const handleSelect = useCallback((company: CompanySummary) => {
    // Prevent duplicates
    if (value.some((v) => v.id === company.id)) {
      setShowPicker(false)
      return
    }
    onChange([...value, { id: company.id, name: company.canonicalName }])
    setShowPicker(false)
  }, [value, onChange])

  const handleRemove = useCallback((id: string) => {
    onChange(value.filter((v) => v.id !== id))
  }, [value, onChange])

  return (
    <div className={styles.container}>
      {value.map((entry) => (
        <span key={entry.id} className={styles.chip}>
          <button
            className={styles.chipName}
            onClick={() => navigate(`/company/${entry.id}`)}
            title={`Open ${entry.name}`}
          >
            {entry.name}
          </button>
          {!readOnly && (
            <button
              className={styles.chipRemove}
              onClick={() => handleRemove(entry.id)}
              title="Remove"
            >
              ×
            </button>
          )}
        </span>
      ))}

      {!readOnly && (
        showPicker ? (
          <EntityPicker<CompanySummary>
            picker={picker}
            placeholder="Search company…"
            renderItem={(c) => c.canonicalName}
            onSelect={handleSelect}
            onClose={() => setShowPicker(false)}
          />
        ) : (
          <button className={styles.addBtn} onClick={() => setShowPicker(true)}>
            + Add company
          </button>
        )
      )}
    </div>
  )
}
