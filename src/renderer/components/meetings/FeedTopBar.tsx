import { useCallback, useRef, useState, useEffect } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import styles from './FeedTopBar.module.css'

interface FeedTopBarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  searchRef?: React.RefObject<HTMLInputElement | null>
}

export function FeedTopBar({ searchQuery, onSearchChange, searchRef: externalRef }: FeedTopBarProps) {
  const internalRef = useRef<HTMLInputElement>(null)
  const inputRef = externalRef ?? internalRef
  const [localQuery, setLocalQuery] = useState(searchQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setLocalQuery(searchQuery)
  }, [searchQuery])

  const handleChange = useCallback((value: string) => {
    setLocalQuery(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => onSearchChange(value), 200)
  }, [onSearchChange])

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  return (
    <div className={styles.bar}>
      <div className={styles.searchWrap}>
        <Search size={14} className={styles.searchIcon} />
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="text"
          placeholder="Search meetings, attendees, companies..."
          value={localQuery}
          onChange={(e) => handleChange(e.target.value)}
        />
        {!localQuery && <span className={styles.searchHint}>/</span>}
      </div>

      <button className={styles.filterBtn} disabled>
        <SlidersHorizontal size={14} />
        Filter
      </button>

      <div className={styles.spacer} />

      <div className={styles.viewSwitch}>
        <button className={`${styles.viewBtn} ${styles.viewBtnActive}`}>Timeline</button>
        <button className={styles.viewBtn} disabled>Table</button>
        <button className={styles.viewBtn} disabled>Calendar</button>
      </div>
    </div>
  )
}
