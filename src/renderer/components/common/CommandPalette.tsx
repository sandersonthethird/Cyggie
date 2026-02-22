import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  UnifiedSearchAnswerResponse,
  UnifiedSearchResponse,
  UnifiedSearchResult
} from '../../../shared/types/unified-search'
import styles from './CommandPalette.module.css'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const EMPTY_RESULTS: UnifiedSearchResponse = {
  query: '',
  totalCount: 0,
  grouped: {
    meeting: [],
    email: [],
    note: [],
    memo: []
  },
  flat: []
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UnifiedSearchResponse>(EMPTY_RESULTS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [streamingAnswer, setStreamingAnswer] = useState('')
  const [answer, setAnswer] = useState<UnifiedSearchAnswerResponse | null>(null)

  const groups = useMemo(() => ([
    { key: 'meeting', label: 'Meetings', items: results.grouped.meeting },
    { key: 'email', label: 'Emails', items: results.grouped.email },
    { key: 'note', label: 'Notes', items: results.grouped.note },
    { key: 'memo', label: 'Memos', items: results.grouped.memo }
  ]), [results])

  useEffect(() => {
    if (!open) return
    const timeout = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timeout)
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!query.trim()) {
      setResults(EMPTY_RESULTS)
      setLoading(false)
      setAnswer(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    const timeout = setTimeout(async () => {
      try {
        const response = await window.api.invoke<UnifiedSearchResponse>(
          IPC_CHANNELS.UNIFIED_SEARCH_QUERY,
          query,
          48
        )
        if (cancelled) return
        setResults(response)
      } catch (err) {
        if (cancelled) return
        setError(String(err))
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }, 180)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [open, query])

  useEffect(() => {
    if (!asking) return
    const unsub = window.api.on(IPC_CHANNELS.CHAT_PROGRESS, (chunk: unknown) => {
      if (chunk == null) {
        setStreamingAnswer('')
        return
      }
      setStreamingAnswer((prev) => prev + String(chunk))
    })
    return unsub
  }, [asking])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const openResult = (result: UnifiedSearchResult) => {
    navigate(result.route)
    onClose()
  }

  const askAi = async () => {
    if (!query.trim() || asking) return
    setAsking(true)
    setStreamingAnswer('')
    setAnswer(null)
    setError(null)
    try {
      const response = await window.api.invoke<UnifiedSearchAnswerResponse>(
        IPC_CHANNELS.UNIFIED_SEARCH_ANSWER,
        query,
        48
      )
      setAnswer(response)
    } catch (err) {
      setError(String(err))
    } finally {
      setAsking(false)
      setStreamingAnswer('')
    }
  }

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div className={styles.inputRow}>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask anything across meetings, emails, notes, and memos..."
          />
          <button
            className={styles.askButton}
            onClick={() => void askAi()}
            disabled={!query.trim() || asking}
          >
            {asking ? 'Asking...' : 'Ask AI'}
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {loading && <div className={styles.meta}>Searching...</div>}
        {!loading && query.trim() && (
          <div className={styles.meta}>{results.totalCount} result{results.totalCount === 1 ? '' : 's'}</div>
        )}

        <div className={styles.results}>
          {groups.map((group) => (
            group.items.length > 0 ? (
              <section key={group.key} className={styles.group}>
                <h3 className={styles.groupTitle}>{group.label}</h3>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={styles.resultRow}
                    onClick={() => openResult(item)}
                  >
                    <span className={styles.resultTitle}>{item.title}</span>
                    <span className={styles.resultMeta}>
                      {[item.companyName, item.citationLabel].filter(Boolean).join(' · ')}
                    </span>
                    {item.snippet && <span className={styles.resultSnippet}>{item.snippet}</span>}
                  </button>
                ))}
              </section>
            ) : null
          ))}
          {!loading && query.trim() && results.totalCount === 0 && (
            <div className={styles.meta}>No sources matched your query.</div>
          )}
        </div>

        {(asking || streamingAnswer || answer) && (
          <section className={styles.answerSection}>
            <h3 className={styles.groupTitle}>AI Answer</h3>
            {asking && streamingAnswer && (
              <pre className={styles.answer}>{streamingAnswer}</pre>
            )}
            {asking && !streamingAnswer && (
              <div className={styles.meta}>Generating answer...</div>
            )}
            {!asking && answer && (
              <>
                <pre className={styles.answer}>{answer.answer}</pre>
                {answer.citations.length > 0 && (
                  <div className={styles.citationList}>
                    {answer.citations.map((citation, index) => (
                      <button
                        key={citation.id}
                        className={styles.citationButton}
                        onClick={() => {
                          navigate(citation.route)
                          onClose()
                        }}
                      >
                        [{index + 1}] {citation.citationLabel}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
