import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useDebounce } from '../../hooks/useDebounce'
import styles from './EntitySearch.module.css'

interface EntitySearchProps {
  entityType: 'contact' | 'company'
  onSelect: (id: string, label: string) => void
  placeholder?: string
}

interface SearchResult {
  id: string
  label: string
}

export function EntitySearch({ entityType, onSelect, placeholder }: EntitySearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const debouncedQuery = useDebounce(query, 250)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([])
      setOpen(false)
      return
    }

    window.api
      .invoke<{ success: boolean; data?: Array<{ id: string; canonicalName?: string; fullName?: string }> }>(
        entityType === 'company' ? IPC_CHANNELS.COMPANY_LIST : IPC_CHANNELS.CONTACT_LIST,
        { query: debouncedQuery, limit: 8 }
      )
      .then((res) => {
        if (!res.success || !res.data) return
        setResults(
          res.data.map((item) => ({
            id: item.id,
            label: item.canonicalName ?? item.fullName ?? item.id
          }))
        )
        setOpen(true)
      })
      .catch(() => setResults([]))
  }, [debouncedQuery, entityType])

  function handleSelect(result: SearchResult) {
    onSelect(result.id, result.label)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className={styles.root} ref={inputRef as React.RefObject<HTMLDivElement>}>
      <input
        className={styles.input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder ?? `Search ${entityType}…`}
        onFocus={() => debouncedQuery && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className={styles.dropdown}>
          {results.map((r) => (
            <button key={r.id} className={styles.option} onMouseDown={() => handleSelect(r)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
