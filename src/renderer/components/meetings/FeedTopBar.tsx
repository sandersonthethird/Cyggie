import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, SlidersHorizontal, X, Calendar } from 'lucide-react'
import { ENTITY_TYPE_OPTIONS } from '../../../shared/types/company'
import type { CompanyEntityType } from '../../../shared/types/company'
import type { MeetingStatus } from '../../../shared/types/meeting'
import MultiSelectFilter from '../common/MultiSelectFilter'
import styles from './FeedTopBar.module.css'

const STATUS_OPTIONS: { value: MeetingStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'recording', label: 'Recording' },
  { value: 'transcribed', label: 'Transcribed' },
  { value: 'summarized', label: 'Summarized' },
  { value: 'error', label: 'Error' },
]

interface FeedTopBarProps {
  searchRef?: React.RefObject<HTMLInputElement | null>
}

export function FeedTopBar({ searchRef: externalRef }: FeedTopBarProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const internalRef = useRef<HTMLInputElement>(null)
  const inputRef = externalRef ?? internalRef
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Search — local state with debounced URL sync
  const searchQuery = searchParams.get('q') ?? ''
  const [localQuery, setLocalQuery] = useState(searchQuery)

  useEffect(() => {
    setLocalQuery(searchQuery)
  }, [searchQuery])

  const handleSearchChange = useCallback((value: string) => {
    setLocalQuery(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        if (value) next.set('q', value)
        else next.delete('q')
        return next
      }, { replace: true })
    }, 200)
  }, [setSearchParams])

  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // Filter param helpers
  const setParam = useCallback((key: string, value: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    }, { replace: true })
  }, [setSearchParams])

  // Entity type filter
  const entityTypeSet = useMemo(() => {
    const raw = searchParams.get('entityType')
    if (!raw) return new Set<CompanyEntityType>()
    return new Set(raw.split(',').filter(v => ENTITY_TYPE_OPTIONS.some(o => o.value === v)) as CompanyEntityType[])
  }, [searchParams])

  const handleEntityTypeChange = useCallback((next: Set<CompanyEntityType>) => {
    setParam('entityType', next.size > 0 ? [...next].join(',') : null)
  }, [setParam])

  // Status filter
  const statusSet = useMemo(() => {
    const raw = searchParams.get('status')
    if (!raw) return new Set<MeetingStatus>()
    return new Set(raw.split(',').filter(v => STATUS_OPTIONS.some(o => o.value === v)) as MeetingStatus[])
  }, [searchParams])

  const handleStatusChange = useCallback((next: Set<MeetingStatus>) => {
    setParam('status', next.size > 0 ? [...next].join(',') : null)
  }, [setParam])

  // Date filters
  const dateFrom = searchParams.get('dateFrom') ?? ''
  const dateTo = searchParams.get('dateTo') ?? ''

  // View mode
  const activeView = searchParams.get('view') === 'calendar' ? 'calendar' : 'timeline'

  // Active filter count
  const activeFilterCount =
    (entityTypeSet.size > 0 ? 1 : 0) +
    (statusSet.size > 0 ? 1 : 0) +
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0)

  const handleClearAll = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('entityType')
      next.delete('status')
      next.delete('dateFrom')
      next.delete('dateTo')
      return next
    }, { replace: true })
  }, [setSearchParams])

  return (
    <div className={styles.topBarWrap}>
      <div className={styles.bar}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            placeholder="Search meetings, attendees, companies..."
            value={localQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {localQuery ? (
            <button
              className={styles.clearBtn}
              onClick={() => handleSearchChange('')}
              title="Clear search"
            >
              ×
            </button>
          ) : (
            <span className={styles.searchHint}>/</span>
          )}
        </div>

        <button
          className={`${styles.filterBtn} ${activeFilterCount > 0 ? styles.filterBtnActive : ''}`}
          onClick={() => setFiltersOpen(v => !v)}
        >
          <SlidersHorizontal size={14} />
          Filter
          {activeFilterCount > 0 && (
            <span className={styles.filterBadge}>{activeFilterCount}</span>
          )}
        </button>

        <div className={styles.spacer} />

        <div className={styles.viewSwitch}>
          <button
            className={`${styles.viewBtn} ${activeView === 'timeline' ? styles.viewBtnActive : ''}`}
            onClick={() => setParam('view', null)}
          >
            Timeline
          </button>
          <button
            className={`${styles.viewBtn} ${activeView === 'calendar' ? styles.viewBtnActive : ''}`}
            onClick={() => setParam('view', 'calendar')}
          >
            <Calendar size={12} />
            Calendar
          </button>
        </div>
      </div>

      {filtersOpen && (
        <div className={styles.filterRow}>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Date</span>
            <input
              type="date"
              className={styles.dateInput}
              value={dateFrom}
              onChange={(e) => setParam('dateFrom', e.target.value || null)}
              placeholder="From"
            />
            <span className={styles.dateSep}>–</span>
            <input
              type="date"
              className={styles.dateInput}
              value={dateTo}
              onChange={(e) => setParam('dateTo', e.target.value || null)}
              placeholder="To"
            />
          </div>

          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Company Type</span>
            <MultiSelectFilter
              options={ENTITY_TYPE_OPTIONS}
              selected={entityTypeSet}
              onChange={handleEntityTypeChange}
              allLabel="All types"
              portal
            />
          </div>

          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Status</span>
            <MultiSelectFilter
              options={STATUS_OPTIONS}
              selected={statusSet}
              onChange={handleStatusChange}
              allLabel="All statuses"
              portal
            />
          </div>

          {activeFilterCount > 0 && (
            <button className={styles.clearAllBtn} onClick={handleClearAll}>
              <X size={12} />
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  )
}
