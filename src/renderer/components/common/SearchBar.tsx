import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore, selectHasActiveFilters } from '../../stores/app.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CategorizedSuggestions } from '../../../shared/types/meeting'
import styles from './SearchBar.module.css'

export default function SearchBar() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setSearchFilter = useAppStore((s) => s.setSearchFilter)
  const [categorized, setCategorized] = useState<CategorizedSuggestions>({ people: [], companies: [], meetings: [] })
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const suggestRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Filter state from store
  const searchDateFrom = useAppStore((s) => s.searchDateFrom)
  const searchDateTo = useAppStore((s) => s.searchDateTo)
  const searchSpeakers = useAppStore((s) => s.searchSpeakers)
  const allSpeakers = useAppStore((s) => s.allSpeakers)
  const showFilterPanel = useAppStore((s) => s.showFilterPanel)
  const setSearchDateFrom = useAppStore((s) => s.setSearchDateFrom)
  const setSearchDateTo = useAppStore((s) => s.setSearchDateTo)
  const setSearchSpeakers = useAppStore((s) => s.setSearchSpeakers)
  const setAllSpeakers = useAppStore((s) => s.setAllSpeakers)
  const setShowFilterPanel = useAppStore((s) => s.setShowFilterPanel)
  const clearAdvancedFilters = useAppStore((s) => s.clearAdvancedFilters)
  const clearSearch = useAppStore((s) => s.clearSearch)
  const hasActiveFilters = useAppStore(selectHasActiveFilters)

  const flatItems = useMemo(() => {
    const items: { type: 'person' | 'company' | 'meeting'; label: string; id?: string; domain?: string }[] = []
    for (const name of categorized.people) items.push({ type: 'person', label: name })
    for (const c of categorized.companies) items.push({ type: 'company', label: c.name, domain: c.domain })
    for (const m of categorized.meetings) items.push({ type: 'meeting', label: m.title, id: m.id })
    return items
  }, [categorized])

  // Clear search state when SearchBar unmounts (user navigated away from meetings)
  useEffect(() => {
    return () => clearSearch()
  }, [clearSearch])

  // Load all speakers on mount
  useEffect(() => {
    window.api.invoke<string[]>(IPC_CHANNELS.SEARCH_ALL_SPEAKERS).then(setAllSpeakers)
  }, [setAllSpeakers])

  // Fetch categorized suggestions as user types
  useEffect(() => {
    if (suggestRef.current) clearTimeout(suggestRef.current)
    if (value.trim().length < 2) {
      setCategorized({ people: [], companies: [], meetings: [] })
      setShowSuggestions(false)
      return
    }
    suggestRef.current = setTimeout(async () => {
      try {
        const results = await window.api.invoke<CategorizedSuggestions>(IPC_CHANNELS.SEARCH_CATEGORIZED, value)
        setCategorized(results)
        const hasResults = results.people.length > 0 || results.companies.length > 0 || results.meetings.length > 0
        setShowSuggestions(hasResults)
        if (hasResults) setShowFilterPanel(false)
        setActiveSuggestion(-1)
      } catch (err) {
        console.error('Failed to fetch categorized suggestions:', err)
      }
    }, 150)
    return () => {
      if (suggestRef.current) clearTimeout(suggestRef.current)
    }
  }, [value, setShowFilterPanel])

  // Close suggestions and filter panel on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
        setShowFilterPanel(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [setShowFilterPanel])

  const handleSuggestionSelect = useCallback((item: typeof flatItems[number]) => {
    setShowSuggestions(false)
    setCategorized({ people: [], companies: [], meetings: [] })
    if (item.type === 'meeting') {
      navigate(`/meeting/${item.id}`)
    } else {
      setValue(item.label)
      setSearchQuery(item.label)
      setSearchFilter({ type: item.type, value: item.label })
    }
  }, [navigate, setSearchQuery, setSearchFilter])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const query = e.target.value
      setValue(query)
      setSearchQuery(query)
      setSearchFilter(null)
    },
    [setSearchQuery, setSearchFilter]
  )

  const handleClear = useCallback(() => {
    setValue('')
    setSearchQuery('')
    setSearchFilter(null)
    clearAdvancedFilters()
    setCategorized({ people: [], companies: [], meetings: [] })
    setShowSuggestions(false)
    setShowFilterPanel(false)
  }, [setSearchQuery, setSearchFilter, clearAdvancedFilters, setShowFilterPanel])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showSuggestions || flatItems.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((prev) => (prev + 1) % flatItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((prev) => (prev <= 0 ? flatItems.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && activeSuggestion >= 0) {
      e.preventDefault()
      handleSuggestionSelect(flatItems[activeSuggestion])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }, [showSuggestions, flatItems, activeSuggestion, handleSuggestionSelect])

  const handleFilterToggle = useCallback(() => {
    setShowFilterPanel(!showFilterPanel)
    setShowSuggestions(false)
  }, [showFilterPanel, setShowFilterPanel])

  const toggleSpeaker = useCallback((name: string) => {
    setSearchSpeakers(
      searchSpeakers.includes(name)
        ? searchSpeakers.filter((s) => s !== name)
        : [...searchSpeakers, name]
    )
  }, [searchSpeakers, setSearchSpeakers])

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <span className={styles.searchIcon}>&#128269;</span>
      <input
        type="text"
        className={styles.input}
        placeholder="Search meetings..."
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (flatItems.length > 0) setShowSuggestions(true)
          setShowFilterPanel(false)
        }}
      />
      <button
        className={`${styles.filterToggle} ${hasActiveFilters ? styles.filterToggleActive : ''}`}
        onClick={handleFilterToggle}
        title="Search filters"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1.5h13l-5 6v5l-3 2v-7z" />
        </svg>
        {hasActiveFilters && <span className={styles.filterBadge} />}
      </button>
      {(value || hasActiveFilters) && (
        <button className={styles.clear} onClick={handleClear}>
          &#10005;
        </button>
      )}
      {showSuggestions && flatItems.length > 0 && (() => {
        let idx = 0
        return (
          <div className={styles.suggestions}>
            {categorized.people.length > 0 && (
              <div className={styles.suggestionSection}>
                <div className={styles.sectionHeader}>People</div>
                {categorized.people.map((name) => {
                  const i = idx++
                  return (
                    <div
                      key={`person-${name}`}
                      className={`${styles.suggestionItem} ${i === activeSuggestion ? styles.suggestionActive : ''}`}
                      onMouseDown={() => handleSuggestionSelect({ type: 'person', label: name })}
                      onMouseEnter={() => setActiveSuggestion(i)}
                    >
                      {name}
                    </div>
                  )
                })}
              </div>
            )}
            {categorized.companies.length > 0 && (
              <div className={styles.suggestionSection}>
                <div className={styles.sectionHeader}>Companies</div>
                {categorized.companies.map((company) => {
                  const i = idx++
                  return (
                    <div
                      key={`company-${company.domain || company.name}`}
                      className={`${styles.suggestionItem} ${styles.companySuggestion} ${i === activeSuggestion ? styles.suggestionActive : ''}`}
                      onMouseDown={() => handleSuggestionSelect({ type: 'company', label: company.name, domain: company.domain })}
                      onMouseEnter={() => setActiveSuggestion(i)}
                    >
                      {company.domain && (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.domain)}&sz=32`}
                          alt=""
                          className={styles.companyLogo}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      {company.name}
                    </div>
                  )
                })}
              </div>
            )}
            {categorized.meetings.length > 0 && (
              <div className={styles.suggestionSection}>
                <div className={styles.sectionHeader}>Meetings</div>
                {categorized.meetings.map((m) => {
                  const i = idx++
                  return (
                    <div
                      key={`meeting-${m.id}`}
                      className={`${styles.suggestionItem} ${i === activeSuggestion ? styles.suggestionActive : ''}`}
                      onMouseDown={() => handleSuggestionSelect({ type: 'meeting', label: m.title, id: m.id })}
                      onMouseEnter={() => setActiveSuggestion(i)}
                    >
                      {m.title}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })()}
      {showFilterPanel && (
        <div className={styles.filterPanel}>
          <div className={styles.filterRow}>
            <div className={styles.filterField}>
              <span className={styles.filterLabel}>From</span>
              <input
                type="date"
                className={styles.dateInput}
                value={searchDateFrom}
                onChange={(e) => setSearchDateFrom(e.target.value)}
              />
            </div>
            <div className={styles.filterField}>
              <span className={styles.filterLabel}>To</span>
              <input
                type="date"
                className={styles.dateInput}
                value={searchDateTo}
                onChange={(e) => setSearchDateTo(e.target.value)}
              />
            </div>
          </div>

          {allSpeakers.length > 0 && (
            <div className={styles.filterRow}>
              <span className={styles.filterLabel}>Participants</span>
              <div className={styles.speakerChips}>
                {allSpeakers.map((name) => (
                  <button
                    key={name}
                    className={`${styles.speakerChip} ${searchSpeakers.includes(name) ? styles.speakerChipActive : ''}`}
                    onClick={() => toggleSpeaker(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasActiveFilters && (
            <div className={styles.filterActions}>
              <button className={styles.clearFiltersBtn} onClick={clearAdvancedFilters}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
