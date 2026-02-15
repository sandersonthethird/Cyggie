import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { SearchResult, AdvancedSearchParams, AdvancedSearchResult } from '../../shared/types/meeting'

export function useSearch() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const searchFilter = useAppStore((s) => s.searchFilter)
  const setSearchResults = useAppStore((s) => s.setSearchResults)
  const setIsSearching = useAppStore((s) => s.setIsSearching)
  const searchResults = useAppStore((s) => s.searchResults)
  const isSearching = useAppStore((s) => s.isSearching)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (!searchQuery.trim()) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    setIsSearching(true)

    debounceRef.current = setTimeout(async () => {
      if (searchFilter) {
        // Person or company filter: use advanced search
        const params: AdvancedSearchParams = {}
        if (searchFilter.type === 'person') params.person = searchFilter.value
        else params.company = searchFilter.value
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
        // Normal FTS search
        const results = await window.api.invoke<SearchResult[]>(
          IPC_CHANNELS.SEARCH_QUERY,
          searchQuery
        )
        setSearchResults(results)
      }
      setIsSearching(false)
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [searchQuery, searchFilter, setSearchResults, setIsSearching])

  return { searchQuery, searchResults, isSearching }
}
