import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import ChatInterface from '../components/chat/ChatInterface'
import { useChatStore } from '../stores/chat.store'
import type { AdvancedSearchParams, AdvancedSearchResult, CategorizedSuggestions } from '../../shared/types/meeting'
import styles from './Query.module.css'

export default function Query() {
  const navigate = useNavigate()
  const clearConversation = useChatStore((s) => s.clearConversation)
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [allSpeakers, setAllSpeakers] = useState<string[]>([])
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([])
  const [results, setResults] = useState<AdvancedSearchResult[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [categorized, setCategorized] = useState<CategorizedSuggestions>({ people: [], companies: [], meetings: [] })
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  // Load all speakers on mount
  useEffect(() => {
    window.api.invoke<string[]>(IPC_CHANNELS.SEARCH_ALL_SPEAKERS).then(setAllSpeakers)
  }, [])

  // Build flat list of all suggestion items for keyboard navigation
  const flatItems = useMemo(() => {
    const items: { type: 'person' | 'company' | 'meeting'; label: string; id?: string; domain?: string }[] = []
    for (const name of categorized.people) items.push({ type: 'person', label: name })
    for (const c of categorized.companies) items.push({ type: 'company', label: c.name, domain: c.domain })
    for (const m of categorized.meetings) items.push({ type: 'meeting', label: m.title, id: m.id })
    return items
  }, [categorized])

  // Fetch suggestions as user types
  useEffect(() => {
    if (suggestRef.current) clearTimeout(suggestRef.current)
    if (query.trim().length < 2) {
      setCategorized({ people: [], companies: [], meetings: [] })
      setShowSuggestions(false)
      return
    }
    suggestRef.current = setTimeout(async () => {
      try {
        const results = await window.api.invoke<CategorizedSuggestions>(IPC_CHANNELS.SEARCH_CATEGORIZED, query)
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
  }, [query])

  // Close suggestions on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
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
      // Person or company: set query text and search by that filter
      setQuery(item.label)
      const params: AdvancedSearchParams = {}
      if (item.type === 'person') params.person = item.label
      else params.company = item.label
      window.api.invoke<AdvancedSearchResult[]>(IPC_CHANNELS.SEARCH_ADVANCED, params).then((data) => {
        setResults(data)
        setHasSearched(true)
      })
    }
  }, [navigate])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
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

  const runSearch = useCallback(async () => {
    const params: AdvancedSearchParams = {}
    if (query.trim()) params.query = query.trim()
    if (dateFrom) params.dateFrom = dateFrom
    if (dateTo) params.dateTo = dateTo
    if (selectedSpeakers.length > 0) params.speakers = selectedSpeakers

    // Only search if at least one filter is set
    if (!params.query && !params.dateFrom && !params.dateTo && !params.speakers) {
      setResults([])
      setHasSearched(false)
      return
    }

    const data = await window.api.invoke<AdvancedSearchResult[]>(IPC_CHANNELS.SEARCH_ADVANCED, params)
    setResults(data)
    setHasSearched(true)
  }, [query, dateFrom, dateTo, selectedSpeakers])

  // Debounced search on filter change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(runSearch, 350)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [runSearch])

  const toggleSpeaker = (name: string) => {
    setSelectedSpeakers((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    )
  }

  const clearFilters = () => {
    setQuery('')
    setDateFrom('')
    setDateTo('')
    setSelectedSpeakers([])
    setResults([])
    setHasSearched(false)
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return null
    if (seconds < 60) return `${seconds}s`
    return `${Math.round(seconds / 60)} min`
  }

  // Clear chat when search results change
  const resultIds = useMemo(() => results.map((r) => r.meetingId), [results])
  useEffect(() => {
    clearConversation('search-results')
  }, [resultIds, clearConversation])

  return (
    <div className={styles.container}>
      <div className={styles.searchBox} ref={searchBoxRef}>
        <span className={styles.searchIcon}>&#128269;</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search transcripts and summaries..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => { if (flatItems.length > 0) setShowSuggestions(true) }}
        />
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

      <button
        className={`${styles.advancedToggle} ${showAdvanced ? styles.advancedToggleActive : ''}`}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        Advanced {showAdvanced ? '\u25B2' : '\u25BC'}
      </button>

      {showAdvanced && (
        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>From</span>
            <input
              className={styles.dateInput}
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>To</span>
            <input
              className={styles.dateInput}
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>

          {allSpeakers.length > 0 && (
            <div className={styles.filterGroup}>
              <span className={styles.filterLabel}>Participants</span>
              <div className={styles.speakerChips}>
                {allSpeakers.map((name) => (
                  <button
                    key={name}
                    className={`${styles.speakerToggle} ${selectedSpeakers.includes(name) ? styles.speakerToggleActive : ''}`}
                    onClick={() => toggleSpeaker(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(dateFrom || dateTo || selectedSpeakers.length > 0) && (
            <button className={styles.clearBtn} onClick={() => {
              setDateFrom('')
              setDateTo('')
              setSelectedSpeakers([])
            }}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {hasSearched && (
        <div className={styles.resultCount}>
          {results.length} result{results.length !== 1 ? 's' : ''}
        </div>
      )}

      {hasSearched && results.length > 0 && (
        <div className={styles.results}>
          {results.map((r) => {
            const speakers = Object.values(r.speakerMap)
            const duration = formatDuration(r.durationSeconds)
            return (
              <div
                key={r.meetingId}
                className={styles.resultCard}
                onClick={() => navigate(`/meeting/${r.meetingId}`)}
              >
                <div className={styles.resultHeader}>
                  <span className={styles.resultTitle}>{r.title}</span>
                  <span
                    className={`${styles.resultStatus} ${
                      r.status === 'summarized' ? styles.statusSummarized : styles.statusTranscribed
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
                <div className={styles.resultMeta}>
                  <span>{new Date(r.date).toLocaleDateString()}</span>
                  {duration && <span>{duration}</span>}
                </div>
                {speakers.length > 0 && (
                  <div className={styles.resultSpeakers}>{speakers.join(', ')}</div>
                )}
                {r.companies && r.companies.length > 0 && (
                  <div className={styles.resultCompanies}>
                    {r.companies.map((c) => (
                      <span key={c.domain || c.name} className={styles.companyTag}>
                        {c.domain && (
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32`}
                            alt=""
                            className={styles.companyTagLogo}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        )}
                        {c.name}
                      </span>
                    ))}
                  </div>
                )}
                {r.snippet && (
                  <div
                    className={styles.resultSnippet}
                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {hasSearched && results.length === 0 && (
        <div className={styles.empty}>No results found. Try different search terms or filters.</div>
      )}

      {!hasSearched && (
        <div className={styles.empty}>
          Search across all your meeting transcripts and summaries. Use the filters above to narrow results.
        </div>
      )}

      {hasSearched && results.length > 0 && (
        <div className={styles.chatSection}>
          <ChatInterface meetingIds={resultIds} />
        </div>
      )}
    </div>
  )
}
