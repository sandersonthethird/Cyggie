import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../../stores/app.store'
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

  const flatItems = useMemo(() => {
    const items: { type: 'person' | 'company' | 'meeting'; label: string; id?: string; domain?: string }[] = []
    for (const name of categorized.people) items.push({ type: 'person', label: name })
    for (const c of categorized.companies) items.push({ type: 'company', label: c.name, domain: c.domain })
    for (const m of categorized.meetings) items.push({ type: 'meeting', label: m.title, id: m.id })
    return items
  }, [categorized])

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
        setActiveSuggestion(-1)
      } catch (err) {
        console.error('Failed to fetch categorized suggestions:', err)
      }
    }, 150)
    return () => {
      if (suggestRef.current) clearTimeout(suggestRef.current)
    }
  }, [value])

  // Close suggestions on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

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
    setCategorized({ people: [], companies: [], meetings: [] })
    setShowSuggestions(false)
  }, [setSearchQuery, setSearchFilter])

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
        onFocus={() => { if (flatItems.length > 0) setShowSuggestions(true) }}
      />
      {value && (
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
    </div>
  )
}
