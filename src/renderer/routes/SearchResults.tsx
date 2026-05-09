import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { UnifiedSearchResponse, UnifiedSearchResult } from '../../shared/types/unified-search'
import { useChatStore } from '../stores/chat.store'
import type { ChatContextKind } from '../../shared/utils/chat-context'
import styles from './SearchResults.module.css'
import { api } from '../api'

interface ChatSearchHit {
  sessionId: string
  messageId: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  snippet: string
  lastMessageAt: string
}

interface PersistedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

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

function CompanyLogo({ domain }: { domain: string | null }) {
  const [stage, setStage] = useState<'clearbit' | 'favicon' | 'none'>(domain ? 'clearbit' : 'none')
  useEffect(() => { setStage(domain ? 'clearbit' : 'none') }, [domain])

  if (!domain || stage === 'none') {
    return <div className={styles.resultLogoPlaceholder} aria-hidden />
  }
  const src = stage === 'clearbit'
    ? `https://logo.clearbit.com/${domain}`
    : `https://www.google.com/s2/favicons?sz=64&domain=${domain}`
  return (
    <img
      src={src}
      className={styles.resultLogo}
      alt=""
      onError={() => setStage(stage === 'clearbit' ? 'favicon' : 'none')}
    />
  )
}

export default function SearchResults() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const query = (searchParams.get('q') || '').trim()

  const [results, setResults] = useState<UnifiedSearchResponse>(EMPTY_RESULTS)
  const [chatHits, setChatHits] = useState<ChatSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadPanelSession = useChatStore((s) => s.loadPanelSession)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!query) {
      setResults(EMPTY_RESULTS)
      setChatHits([])
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    debounceRef.current = setTimeout(async () => {
      try {
        const [response, chats] = await Promise.all([
          api.invoke<UnifiedSearchResponse>(IPC_CHANNELS.UNIFIED_SEARCH_QUERY, query, 60),
          api.invoke<ChatSearchHit[]>(IPC_CHANNELS.CHAT_SESSION_SEARCH, query, 30),
        ])
        if (!cancelled) {
          setResults(response)
          setChatHits(chats)
        }
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

  const openChatHit = async (hit: ChatSearchHit) => {
    try {
      const messages = await api.invoke<PersistedMessage[]>(
        IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
        hit.sessionId
      )
      loadPanelSession(
        hit.sessionId,
        hit.contextId,
        hit.contextKind,
        hit.contextLabel,
        messages.map((m) => ({ role: m.role, content: m.content }))
      )
    } catch (err) {
      console.warn('[SearchResults] failed to load chat messages', err)
    }
  }

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

      {!loading && !error && groups.length === 0 && chatHits.length === 0 && (
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
                <CompanyLogo domain={item.companyDomain} />
                <div className={styles.resultBody}>
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
                </div>
              </button>
            ))}
          </section>
        ))}
        {chatHits.length > 0 && (
          <section className={styles.group}>
            <h3 className={styles.groupTitle}>Chats</h3>
            {chatHits.map((hit) => (
              <button
                key={`${hit.sessionId}-${hit.messageId}`}
                className={styles.resultRow}
                onClick={() => void openChatHit(hit)}
              >
                <CompanyLogo domain={null} />
                <div className={styles.resultBody}>
                  <div className={styles.resultHeader}>
                    <span className={styles.resultTitle}>
                      {hit.title ?? '(Untitled chat)'}
                    </span>
                    {hit.lastMessageAt && (
                      <span className={styles.resultDate}>{formatDate(hit.lastMessageAt)}</span>
                    )}
                  </div>
                  {hit.contextLabel && (
                    <span className={styles.resultCompany}>{hit.contextLabel}</span>
                  )}
                  {hit.snippet && (
                    <span
                      className={styles.resultSnippet}
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(hit.snippet) }}
                    />
                  )}
                </div>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
