import { useEffect, useRef, useState } from 'react'
import type { PickerState } from '../../hooks/usePicker'
import styles from './EntityPicker.module.css'

interface EntityPickerProps<T extends { id: string }> {
  picker: PickerState<T>
  renderItem: (item: T) => React.ReactNode
  placeholder?: string
  onSelect: (item: T) => void
  onClose: () => void
}

export function EntityPicker<T extends { id: string }>({
  picker,
  renderItem,
  placeholder = 'Search…',
  onSelect,
  onClose
}: EntityPickerProps<T>) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Focus input on mount and load initial results
  useEffect(() => {
    inputRef.current?.focus()
    picker.search('', 0)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search on query change
  useEffect(() => {
    picker.search(query)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(-1)
  }, [picker.results])

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex < 0 || !dropdownRef.current) return
    const item = dropdownRef.current.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const { results, searching } = picker

  return (
    <div className={styles.picker} ref={rootRef}>
      <input
        ref={inputRef}
        className={styles.input}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { onClose(); return }
          if (results.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex((i) => Math.min(i + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (activeIndex >= 0 && activeIndex < results.length) {
              onSelect(results[activeIndex])
            }
          }
        }}
      />
      <div className={styles.dropdown} ref={dropdownRef}>
        {searching ? (
          <div className={styles.empty}>Searching…</div>
        ) : results.length === 0 ? (
          <div className={styles.empty}>No results found</div>
        ) : (
          results.map((item, i) => (
            <div
              key={item.id}
              className={`${styles.item} ${i === activeIndex ? styles.itemActive : ''}`}
              onMouseDown={() => onSelect(item)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {renderItem(item)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
