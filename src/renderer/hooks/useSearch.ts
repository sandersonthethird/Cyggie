import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { SearchResult } from '../../shared/types/meeting'

export function useSearch() {
  const searchQuery = useAppStore((s) => s.searchQuery)
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
      const results = await window.api.invoke<SearchResult[]>(
        IPC_CHANNELS.SEARCH_QUERY,
        searchQuery
      )
      setSearchResults(results)
      setIsSearching(false)
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [searchQuery, setSearchResults, setIsSearching])

  return { searchQuery, searchResults, isSearching }
}
