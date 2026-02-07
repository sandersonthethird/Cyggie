import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import ChatInterface from '../components/chat/ChatInterface'
import type { AdvancedSearchParams, AdvancedSearchResult } from '../../shared/types/meeting'
import styles from './Query.module.css'

type QueryMode = 'search' | 'chat'

export default function Query() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<QueryMode>('search')
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [allSpeakers, setAllSpeakers] = useState<string[]>([])
  const [selectedSpeakers, setSelectedSpeakers] = useState<string[]>([])
  const [results, setResults] = useState<AdvancedSearchResult[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  // Load all speakers on mount
  useEffect(() => {
    window.api.invoke<string[]>(IPC_CHANNELS.SEARCH_ALL_SPEAKERS).then(setAllSpeakers)
  }, [])

  // Fetch suggestions as user types
  useEffect(() => {
    if (suggestRef.current) clearTimeout(suggestRef.current)
    if (query.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    suggestRef.current = setTimeout(async () => {
      const results = await window.api.invoke<string[]>(IPC_CHANNELS.SEARCH_SUGGEST, query)
      setSuggestions(results)
      setShowSuggestions(results.length > 0)
      setActiveSuggestion(-1)
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

  const handleSuggestionSelect = useCallback((term: string) => {
    setQuery(term)
    setShowSuggestions(false)
    setSuggestions([])
  }, [])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((prev) => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && activeSuggestion >= 0) {
      e.preventDefault()
      handleSuggestionSelect(suggestions[activeSuggestion])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }, [showSuggestions, suggestions, activeSuggestion, handleSuggestionSelect])

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

  return (
    <div className={styles.container}>
      <div className={styles.modeToggle}>
        <button
          className={`${styles.modeBtn} ${mode === 'search' ? styles.modeBtnActive : ''}`}
          onClick={() => setMode('search')}
        >
          Search
        </button>
        <button
          className={`${styles.modeBtn} ${mode === 'chat' ? styles.modeBtnActive : ''}`}
          onClick={() => setMode('chat')}
        >
          AI Chat
        </button>
      </div>

      {mode === 'chat' && (
        <ChatInterface placeholder="Ask about your meetings..." />
      )}

      {mode === 'search' && (
        <>
      <div className={styles.searchBox} ref={searchBoxRef}>
        <span className={styles.searchIcon}>&#128269;</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search transcripts and summaries..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true) }}
        />
        {showSuggestions && suggestions.length > 0 && (
          <ul className={styles.suggestions}>
            {suggestions.map((term, i) => (
              <li
                key={term}
                className={`${styles.suggestionItem} ${i === activeSuggestion ? styles.suggestionActive : ''}`}
                onMouseDown={() => handleSuggestionSelect(term)}
                onMouseEnter={() => setActiveSuggestion(i)}
              >
                {term}
              </li>
            ))}
          </ul>
        )}
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
        </>
      )}
    </div>
  )
}
