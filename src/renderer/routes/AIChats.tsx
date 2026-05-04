import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, Filter, Calendar as CalendarIcon } from 'lucide-react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../stores/chat.store'
import { useChatPanelStore } from '../stores/chat-panel.store'
import { useChatActions, type ChatSessionRow } from '../hooks/useChatActions'
import { deriveChatContext } from '../../shared/utils/chat-context'
import {
  bucketFor,
  TIME_BUCKET_ORDER,
  TIME_BUCKET_LABEL,
  bucketHeaderRange,
} from '../utils/time-bucket'
import ChatRow from '../components/ai-chats/ChatRow'
import PinnedChatCard from '../components/ai-chats/PinnedChatCard'
import styles from './AIChats.module.css'
import type { ChatPageContext } from '../../shared/types/chat'

interface PersistedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

interface ChatSessionSearchHit {
  sessionId: string
  messageId: string
  contextId: string
  contextKind: ChatSessionRow['contextKind']
  contextLabel: string | null
  title: string | null
  snippet: string
  lastMessageAt: string
}

function pageContextId(pageContext: ChatPageContext | null): string | null {
  if (!pageContext) return null
  const ctx = deriveChatContext({
    meetingId: pageContext.meetingId,
    meetingIds: pageContext.meetingIds,
    companyId:
      pageContext.contextOptions?.[0]?.type === 'company'
        ? pageContext.contextOptions[0].id
        : undefined,
    contactId:
      pageContext.contextOptions?.[0]?.type === 'contact'
        ? pageContext.contextOptions[0].id
        : undefined,
  })
  return ctx?.contextId ?? null
}

export default function AIChats() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const loadPanelSession = useChatStore((s) => s.loadPanelSession)
  const panelSession = useChatStore((s) => s.panelSession)
  const modalOpen = useChatStore((s) => s.modalOpen)
  const pageContext = useChatStore((s) => s.pageContext)
  // Panel store integration: row click opens chat in the side panel; subscribe
  // to lastActionAt so panel mutations refresh the list.
  const setPanelOpen = useChatPanelStore((s) => s.setOpen)
  const setOpenSessionId = useChatPanelStore((s) => s.setOpenSessionId)
  const panelOpenSessionId = useChatPanelStore((s) => s.openSessionId)
  const lastActionAt = useChatPanelStore((s) => s.lastActionAt)

  const actions = useChatActions()

  const [sessions, setSessions] = useState<ChatSessionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ChatSessionSearchHit[] | null>(null)

  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const refreshKey = useRef(0)

  const fetchList = useCallback(async () => {
    setError(null)
    try {
      const rows = await api.invoke<ChatSessionRow[]>(
        IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
        { limit: 100 }
      )
      setSessions(rows)
    } catch (err) {
      console.warn('[AIChats] list failed', err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const rows = await api.invoke<ChatSessionRow[]>(
          IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
          { limit: 100 }
        )
        if (!cancelled) setSessions(rows)
      } catch (err) {
        if (!cancelled) {
          console.warn('[AIChats] list failed', err)
          setError(String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Refetch when window regains focus (locked: 4A) — covers cross-app changes.
  useEffect(() => {
    const handler = () => void fetchList()
    window.addEventListener('focus', handler)
    return () => window.removeEventListener('focus', handler)
  }, [fetchList])

  // Refetch when the modal closes — covers in-app modal mutations (locked: 1A).
  const prevModalOpen = useRef(modalOpen)
  useEffect(() => {
    if (prevModalOpen.current && !modalOpen) {
      void fetchList()
    }
    prevModalOpen.current = modalOpen
  }, [modalOpen, fetchList])

  // Refetch when the chat panel reports a mutation (pin / rename / send / etc.).
  // Skips the very first mount since fetchList already runs in the mount effect.
  const initialActionAt = useRef(lastActionAt)
  useEffect(() => {
    if (lastActionAt === initialActionAt.current) return
    void fetchList()
  }, [lastActionAt, fetchList])

  // Debounced search.
  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (trimmed.length < 2) {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const t = window.setTimeout(async () => {
      try {
        const results = await api.invoke<ChatSessionSearchHit[]>(
          IPC_CHANNELS.CHAT_SESSION_SEARCH,
          trimmed,
          50
        )
        if (!cancelled) setSearchResults(results)
      } catch (err) {
        if (!cancelled) {
          console.warn('[AIChats] search failed', err)
          setSearchResults([])
        }
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [searchQuery])

  // Consume URL deep-link `?openChat=<id>` once — open the modal then clear param.
  const deepLinkConsumed = useRef(false)
  useEffect(() => {
    if (deepLinkConsumed.current) return
    if (loading) return
    const id = searchParams.get('openChat')
    if (!id) return

    // Skip the network round-trip entirely if the session isn't in the list —
    // avoids a wasted IPC call and prevents test leakage across deep-link calls.
    const session = sessions.find((s) => s.id === id)
    deepLinkConsumed.current = true

    if (!session) {
      console.warn('[AIChats] deep-link session not in recent list', id)
      // Clear the param so refresh doesn't re-attempt.
      const next = new URLSearchParams(searchParams)
      next.delete('openChat')
      setSearchParams(next, { replace: true })
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const messages = await api.invoke<PersistedMessage[]>(
          IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
          id
        )
        if (cancelled) return
        loadPanelSession(
          session.id,
          session.contextId,
          session.contextKind,
          session.contextLabel,
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
        window.requestAnimationFrame(() => {
          rowRefs.current.get(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        })
      } catch (err) {
        if (!cancelled) console.warn('[AIChats] deep-link load failed', err)
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams)
          next.delete('openChat')
          setSearchParams(next, { replace: true })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loading, sessions, searchParams, setSearchParams, loadPanelSession])

  const currentPageContextId = useMemo(() => pageContextId(pageContext), [pageContext])

  // Group sessions by pinned vs time-buckets for the body.
  const grouped = useMemo(() => {
    const pinned: ChatSessionRow[] = []
    const buckets: Record<string, ChatSessionRow[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      lastWeek: [],
      earlier: [],
    }
    const now = new Date()
    for (const s of sessions) {
      if (s.isPinned) {
        pinned.push(s)
        continue
      }
      const bucket = bucketFor(s.lastMessageAt, now)
      buckets[bucket].push(s)
    }
    return { pinned, buckets }
  }, [sessions])

  const totalCount = sessions.length

  // Optimistic mutation handlers — update local state, fire IPC, revert on error.
  const handlePin = useCallback(
    async (id: string) => {
      const prev = sessions
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, isPinned: true } : s)))
      try {
        await actions.pin(id)
      } catch (err) {
        console.warn('[AIChats] pin failed', err)
        setSessions(prev)
      }
    },
    [actions, sessions]
  )

  const handleUnpin = useCallback(
    async (id: string) => {
      const prev = sessions
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, isPinned: false } : s)))
      try {
        await actions.unpin(id)
      } catch (err) {
        console.warn('[AIChats] unpin failed', err)
        setSessions(prev)
      }
    },
    [actions, sessions]
  )

  const handleArchive = useCallback(
    async (id: string) => {
      const prev = sessions
      setSessions((cur) => cur.filter((s) => s.id !== id))
      try {
        await actions.archive(id)
      } catch (err) {
        console.warn('[AIChats] archive failed', err)
        setSessions(prev)
      }
    },
    [actions, sessions]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const prev = sessions
      setSessions((cur) => cur.filter((s) => s.id !== id))
      try {
        await actions.delete(id)
      } catch (err) {
        console.warn('[AIChats] delete failed', err)
        setSessions(prev)
      }
    },
    [actions, sessions]
  )

  const handleRename = useCallback(
    async (id: string, title: string) => {
      const prev = sessions
      setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s)))
      try {
        await actions.rename(id, title)
      } catch (err) {
        console.warn('[AIChats] rename failed', err)
        setSessions(prev)
      }
    },
    [actions, sessions]
  )

  const handleRowClick = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id)
      if (!session) return
      try {
        const messages = await api.invoke<PersistedMessage[]>(
          IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
          id
        )
        loadPanelSession(
          session.id,
          session.contextId,
          session.contextKind,
          session.contextLabel,
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
        // Open chat in the new side panel (replacing the legacy modal-only flow).
        setOpenSessionId(id)
        setPanelOpen(true)
      } catch (err) {
        console.warn('[AIChats] load messages failed', err)
        await fetchList()
      }
    },
    [sessions, loadPanelSession, fetchList, setOpenSessionId, setPanelOpen]
  )

  const handleOpenFullScreen = useCallback(
    (id: string) => {
      navigate(`/ai-chats/${id}`)
    },
    [navigate]
  )

  const showingSearch = searchQuery.trim().length >= 2 && searchResults !== null
  // selected = panel's open session OR legacy modal panelSession (during the
  // additive period both surfaces drive selection state).
  const selectedId = panelOpenSessionId ?? panelSession?.sessionId ?? null

  // Render

  if (loading) {
    return (
      <div className={styles.page}>
        <PageHeader totalCount={0} />
        <div className={styles.loading}>Loading chats…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.page}>
        <PageHeader totalCount={0} />
        <div className={styles.errorBlock}>
          <p>Couldn't load chats.</p>
          <button
            className={styles.retryBtn}
            onClick={() => {
              setLoading(true)
              setError(null)
              refreshKey.current++
              void fetchList()
            }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <PageHeader totalCount={totalCount} />

      <div className={styles.toolbar}>
        <div className={styles.searchWrap}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Search chats and messages…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <span className={styles.searchKbd}>/</span>
        </div>
        <button className={styles.filterBtn} disabled title="Filter by linked entity (coming soon)">
          <Filter size={12} />
          All entities
        </button>
        <button className={styles.filterBtn} disabled title="Filter by time range (coming soon)">
          <CalendarIcon size={12} />
          Last 30 days
        </button>
      </div>

      <div className={styles.body}>
        {showingSearch ? (
          <SearchSection
            results={searchResults!}
            query={searchQuery.trim()}
            selectedId={selectedId}
            onClick={handleRowClick}
            onPin={handlePin}
            onUnpin={handleUnpin}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onRename={handleRename}
          />
        ) : sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {grouped.pinned.length > 0 && (
              <section className={styles.pinnedSection}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionLabel}>📌 PINNED</span>
                </div>
                <div className={styles.pinnedGrid}>
                  {grouped.pinned.map((row) => (
                    <PinnedChatCard
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onClick={() => handleRowClick(row.id)}
                      onUnpin={() => handleUnpin(row.id)}
                      onArchive={() => handleArchive(row.id)}
                      onDelete={() => handleDelete(row.id)}
                      onRename={(t) => handleRename(row.id, t)}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className={styles.allSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>All chats</span>
                <span className={styles.sectionCount}>
                  {totalCount} conversation{totalCount === 1 ? '' : 's'}
                </span>
              </div>

              {TIME_BUCKET_ORDER.map((bucket) => {
                const items = grouped.buckets[bucket]
                if (!items || items.length === 0) return null
                const range = bucketHeaderRange(bucket)
                return (
                  <div key={bucket} className={styles.bucketGroup}>
                    <div className={styles.bucketHeader}>
                      <span className={styles.bucketLabel}>{TIME_BUCKET_LABEL[bucket]}</span>
                      {range && (
                        <span className={styles.bucketRange}>
                          {range} · {items.length}
                        </span>
                      )}
                    </div>
                    {items.map((row) => (
                      <div
                        key={row.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(row.id, el)
                          else rowRefs.current.delete(row.id)
                        }}
                      >
                        <ChatRow
                          row={row}
                          selected={row.id === selectedId}
                          onClick={() => handleRowClick(row.id)}
                          onPin={() => handlePin(row.id)}
                          onUnpin={() => handleUnpin(row.id)}
                          onArchive={() => handleArchive(row.id)}
                          onDelete={() => handleDelete(row.id)}
                          onRename={(t) => handleRename(row.id, t)}
                          onOpenFullScreen={() => handleOpenFullScreen(row.id)}
                        />
                      </div>
                    ))}
                  </div>
                )
              })}

              {/* Within-page context hint when relevant — shown above lists if we have a current page context with chats */}
              {currentPageContextId &&
                sessions.some((s) => s.contextId === currentPageContextId) &&
                null /* Hint reserved for future iteration */}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function PageHeader({ totalCount }: { totalCount: number }) {
  return (
    <div className={styles.header}>
      <div className={styles.breadcrumb}>
        <span className={styles.breadcrumbHome}>Cyggie</span>
        <span className={styles.breadcrumbSep}>/</span>
        <span>AI Chats</span>
      </div>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>AI Chats</h1>
        {totalCount > 0 && <span className={styles.countPill}>{totalCount}</span>}
      </div>
      <p className={styles.subtitle}>
        Your conversations with Cyggie AI. Pinned chats stay above; everything else flows in
        chronological order — newest first.
      </p>
    </div>
  )
}

interface SearchSectionProps {
  results: ChatSessionSearchHit[]
  query: string
  selectedId: string | null
  onClick: (id: string) => void
  onPin: (id: string) => void
  onUnpin: (id: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, t: string) => Promise<void>
}

function SearchSection({
  results,
  query,
  selectedId,
  onClick,
  onPin,
  onUnpin,
  onArchive,
  onDelete,
  onRename,
}: SearchSectionProps) {
  if (results.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No chats match "{query}".</p>
      </div>
    )
  }
  return (
    <section className={styles.allSection}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Search results</span>
        <span className={styles.sectionCount}>
          {results.length} match{results.length === 1 ? '' : 'es'}
        </span>
      </div>
      {results.map((r) => {
        const fakeRow: ChatSessionRow = {
          id: r.sessionId,
          contextId: r.contextId,
          contextKind: r.contextKind,
          contextLabel: r.contextLabel,
          title: r.title ?? r.snippet.replace(/<\/?mark>/g, ''),
          previewText: r.snippet.replace(/<\/?mark>/g, ''),
          messageCount: 0,
          isActive: false,
          isPinned: false,
          isArchived: false,
          lastMessageAt: r.lastMessageAt,
        }
        return (
          <ChatRow
            key={`${r.sessionId}-${r.messageId}`}
            row={fakeRow}
            selected={r.sessionId === selectedId}
            onClick={() => onClick(r.sessionId)}
            onPin={() => onPin(r.sessionId)}
            onUnpin={() => onUnpin(r.sessionId)}
            onArchive={() => onArchive(r.sessionId)}
            onDelete={() => onDelete(r.sessionId)}
            onRename={(t) => onRename(r.sessionId, t)}
          />
        )
      })}
    </section>
  )
}

function EmptyState() {
  return (
    <div className={styles.emptyState}>
      <h3>No chats yet</h3>
      <p>Start a chat using the input at the bottom of the screen and your conversations will appear here.</p>
    </div>
  )
}
