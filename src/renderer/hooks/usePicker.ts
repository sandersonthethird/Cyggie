import { useCallback, useRef, useState } from 'react'
import { api } from '../api'

export interface PickerState<T> {
  results: T[]
  searching: boolean
  search: (query: string, delay?: number) => void
}

export function usePicker<T>(
  channel: string,
  limit = 20,
  extraParams?: Record<string, unknown>
): PickerState<T> {
  const [results, setResults] = useState<T[]>([])
  const [searching, setSearching] = useState(false)
  const searchIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref keeps extraParams fresh inside the memoized callback without adding
  // it to the dependency array (which would cause a new closure each render).
  const extraParamsRef = useRef(extraParams)
  extraParamsRef.current = extraParams

  const search = useCallback(
    (query: string, delay = 250) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        const id = ++searchIdRef.current
        setSearching(true)
        api
          .invoke<T[]>(channel, { query: query || undefined, limit, ...extraParamsRef.current })
          .then((data) => {
            if (searchIdRef.current === id) {
              setResults(data ?? [])
              setSearching(false)
            }
          })
          .catch(() => {
            if (searchIdRef.current === id) {
              setResults([])
              setSearching(false)
            }
          })
      }, delay)
    },
    [channel, limit]
  )

  return { results, searching, search }
}
