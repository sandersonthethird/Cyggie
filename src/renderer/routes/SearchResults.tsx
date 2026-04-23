import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { UnifiedSearchResponse, UnifiedSearchResult } from '../../shared/types/unified-search'
import styles from './SearchResults.module.css'
import { api } from '../api'

const ENTITY_LABELS: Record<string, string> = {
  company: 'Companies',
  contact: 'Contacts',
  meeting: 'Meetings',
  email: 'Emails',
  note: 'Notes',
  memo: 'Memos'
}

const GROUP_ORDER = ['company', 'contact', 'meeting', 'email', 'note', 'memo'] as const

const EMPTY_RESULTS: UnifiedSearchResponse = {
  query: '',
  totalCount: 0,
  grouped: { meeting: [], email: [], note: [], memo: [], company: [], contact: [] },
  flat: []
}

/** Strip all HTML except <mark> and </mark> for safe snippet rendering. */
export function sanitizeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, '')
}

function formatDate(value: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SearchResults() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const query = (searchParams.get('q') || '').trim()

  const [results, setResults] = useState<UnifiedSearchResponse>(EMPTY_RESULTS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!query) {
      setResults(EMPTY_RESULTS)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    debounceRef.current = setTimeout(async () => {
      try {
        const response = await api.invoke<UnifiedSearchResponse>(
          IPC_CHANNELS.UNIFIED_SEARCH_QUERY,
          query,
          60
        )
        if (!cancelled) setResults(response)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const groups = useMemo(() =>
    GROUP_ORDER
      .map((key) => ({
        key,
        label: ENTITY_LABELS[key] || key,
        items: results.grouped[key] || []
      }))
      .filter((g) => g.items.length > 0),
    [results]
  )

  const openResult = (result: UnifiedSearchResult) => {
    navigate(result.route, { state: { backLabel: 'Search' } })
  }

  if (!query) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>Type a search query to find results across your entire database.</div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          Results for &ldquo;{query}&rdquo;
        </h2>
        {!loading && (
          <span className={styles.count}>
            {results.totalCount} result{results.totalCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {loading && <div className={styles.meta}>Searching...</div>}
      {error && <div className={styles.error}>{error}</div>}

      {!loading && !error && groups.length === 0 && (
        <div className={styles.empty}>No results found for &ldquo;{query}&rdquo;</div>
      )}

      <div className={styles.results}>
        {groups.map((group) => (
          <section key={group.key} className={styles.group}>
            <h3 className={styles.groupTitle}>{group.label}</h3>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={styles.resultRow}
                onClick={() => openResult(item)}
              >
                <div className={styles.resultHeader}>
                  <span className={styles.resultTitle}>{item.title}</span>
                  {item.occurredAt && (
                    <span className={styles.resultDate}>{formatDate(item.occurredAt)}</span>
                  )}
                </div>
                {item.companyName && (
                  <span className={styles.resultCompany}>{item.companyName}</span>
                )}
                {item.snippet && (
                  <span
                    className={styles.resultSnippet}
                    dangerouslySetInnerHTML={{ __html: sanitizeSnippet(item.snippet) }}
                  />
                )}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
