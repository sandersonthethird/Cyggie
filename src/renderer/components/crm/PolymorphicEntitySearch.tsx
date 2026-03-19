import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import styles from './PolymorphicEntitySearch.module.css'
import type { CompanySummary } from '../../../shared/types/company'
import type { ContactSummary } from '../../../shared/types/contact'

export type EntityType = 'company' | 'contact'

export interface PolymorphicEntity {
  id: string
  name: string
  type: EntityType
  subtitle?: string
}

interface PolymorphicEntitySearchProps {
  onSelect: (entity: PolymorphicEntity) => void
  onClose: () => void
  placeholder?: string
}

export function PolymorphicEntitySearch({
  onSelect,
  onClose,
  placeholder = 'Search company or contact…'
}: PolymorphicEntitySearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PolymorphicEntity[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchIdRef = useRef(0)

  // Focus on mount, load initial results
  useEffect(() => {
    inputRef.current?.focus()
    runSearch('')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search on query change
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => runSearch(query), 250)
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  function runSearch(q: string) {
    const id = ++searchIdRef.current
    setSearching(true)

    const filter = { query: q || undefined, limit: 15 }

    Promise.allSettled([
      api.invoke<CompanySummary[]>(IPC_CHANNELS.COMPANY_LIST, { ...filter, view: 'all' }),
      api.invoke<ContactSummary[]>(IPC_CHANNELS.CONTACT_LIST, filter)
    ]).then(([companyResult, contactResult]) => {
      if (searchIdRef.current !== id) return

      const merged: PolymorphicEntity[] = []

      if (companyResult.status === 'fulfilled') {
        for (const c of companyResult.value ?? []) {
          merged.push({ id: c.id, name: c.canonicalName, type: 'company' })
        }
      }
      if (contactResult.status === 'fulfilled') {
        for (const c of contactResult.value ?? []) {
          merged.push({
            id: c.id,
            name: c.fullName,
            type: 'contact',
            subtitle: c.primaryCompanyName ?? undefined
          })
        }
      }

      setResults(merged)
      setSearching(false)
      setActiveIndex(-1)
    })
  }

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
              key={`${item.type}:${item.id}`}
              className={`${styles.item} ${i === activeIndex ? styles.itemActive : ''}`}
              onMouseDown={() => onSelect(item)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className={styles.itemName}>{item.name}</span>
              <span className={styles.itemMeta}>
                <span className={`${styles.badge} ${styles[item.type]}`}>{item.type}</span>
                {item.subtitle && <span className={styles.itemSub}>{item.subtitle}</span>}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
