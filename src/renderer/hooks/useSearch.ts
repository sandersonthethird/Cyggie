import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { SearchResult, AdvancedSearchParams, AdvancedSearchResult } from '../../shared/types/meeting'

export function useSearch() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const searchFilter = useAppStore((s) => s.searchFilter)
  const searchDateFrom = useAppStore((s) => s.searchDateFrom)
  const searchDateTo = useAppStore((s) => s.searchDateTo)
  const searchSpeakers = useAppStore((s) => s.searchSpeakers)
  const setSearchResults = useAppStore((s) => s.setSearchResults)
  const setIsSearching = useAppStore((s) => s.setIsSearching)
  const searchResults = useAppStore((s) => s.searchResults)
  const isSearching = useAppStore((s) => s.isSearching)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const hasQuery = searchQuery.trim().length > 0
  const hasFilters = searchDateFrom !== '' || searchDateTo !== '' || searchSpeakers.length > 0
  const hasSearchFilter = searchFilter !== null

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (!hasQuery && !hasFilters && !hasSearchFilter) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    setIsSearching(true)

    debounceRef.current = setTimeout(async () => {
      try {
        const needsAdvanced = hasFilters || hasSearchFilter

        if (needsAdvanced) {
          const params: AdvancedSearchParams = {}
          if (hasQuery) params.query = searchQuery.trim()
          if (searchFilter?.type === 'person') params.person = searchFilter.value
          else if (searchFilter?.type === 'company') params.company = searchFilter.value
          if (searchDateFrom) params.dateFrom = searchDateFrom
          if (searchDateTo) params.dateTo = searchDateTo
          if (searchSpeakers.length > 0) params.speakers = searchSpeakers

          const results = await window.api.invoke<AdvancedSearchResult[]>(
            IPC_CHANNELS.SEARCH_ADVANCED,
            params
          )
          setSearchResults(
            results.map((r) => ({
              meetingId: r.meetingId,
              title: r.title,
              date: r.date,
              snippet: r.snippet,
              rank: r.rank
            }))
          )
        } else {
          const results = await window.api.invoke<SearchResult[]>(
            IPC_CHANNELS.SEARCH_QUERY,
            searchQuery
          )
          setSearchResults(results)
        }
      } catch (err) {
        console.error('Search failed:', err)
        setSearchResults([])
      }
      setIsSearching(false)
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [searchQuery, searchFilter, searchDateFrom, searchDateTo, searchSpeakers, setSearchResults, setIsSearching])

  return { searchQuery, searchResults, isSearching, hasFilters: hasFilters || hasSearchFilter }
}
