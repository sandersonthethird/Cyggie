import { useEffect, useMemo, useRef, useState } from 'react'
import type { PickerState } from '../../hooks/usePicker'
import { useListboxNavigation } from '../../hooks/useListboxNavigation'
import { useOutsideClick } from '../../hooks/useOutsideClick'
import styles from './EntityPicker.module.css'

interface EntityPickerProps<T extends { id: string }> {
  picker: PickerState<T>
  renderItem: (item: T) => React.ReactNode
  placeholder?: string
  onSelect: (item: T) => void
  onClose: () => void
  onCreate?: (query: string) => void
}

type NavItem<T> = { kind: 'result'; item: T } | { kind: 'create'; query: string }

export function EntityPicker<T extends { id: string }>({
  picker,
  renderItem,
  placeholder = 'Search…',
  onSelect,
  onClose,
  onCreate
}: EntityPickerProps<T>) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
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

  useOutsideClick(rootRef, onClose)

  const { results, searching } = picker
  const hasCreate = !!onCreate && !!query.trim()

  const navItems = useMemo<NavItem<T>[]>(() => {
    const list: NavItem<T>[] = results.map((item) => ({ kind: 'result' as const, item }))
    if (hasCreate) list.push({ kind: 'create', query: query.trim() })
    return list
  }, [results, hasCreate, query])

  const { activeIndex, setActiveIndex, onKeyDown, listRef } = useListboxNavigation<NavItem<T>>(
    navItems,
    {
      initialIndex: -1,
      onEscape: onClose,
      onSelect: (entry) => {
        if (entry.kind === 'result') onSelect(entry.item)
        else if (onCreate) onCreate(entry.query)
      }
    }
  )

  // Reset active index when results identity changes (new query batch).
  useEffect(() => {
    setActiveIndex(-1)
  }, [results, setActiveIndex])

  return (
    <div className={styles.picker} ref={rootRef}>
      <input
        ref={inputRef}
        className={styles.input}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.dropdown} ref={listRef as React.RefObject<HTMLDivElement>}>
        {searching ? (
          <div className={styles.empty}>Searching…</div>
        ) : results.length === 0 && !hasCreate ? (
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
        {hasCreate && (
          <div
            className={`${styles.item} ${styles.createItem} ${activeIndex === results.length ? styles.itemActive : ''}`}
            onMouseDown={() => onCreate!(query.trim())}
            onMouseEnter={() => setActiveIndex(results.length)}
          >
            Create "{query}"
          </div>
        )}
      </div>
    </div>
  )
}
