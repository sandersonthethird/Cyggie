import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import type { ChatSessionRow } from '../../hooks/useChatActions'
import styles from './PanelSwitcher.module.css'

interface PanelSwitcherProps {
  sessions: ChatSessionRow[]
  loading: boolean
  /** Click a row → caller sets openSessionId + switches mode to 'thread'. */
  onSelectSession: (id: string) => void
  /** "+ New chat" / typing in the bottom input → caller derives context from
   *  the current pageContext, creates a session, switches to thread. */
  onNewChat: (initialQuery?: string) => void
  onSetTotalChats?: (n: number) => void
}

interface SearchHit {
  sessionId: string
  messageId: string
  title: string | null
  snippet: string
  lastMessageAt: string
  contextLabel: string | null
}

/** Compact recents list for the panel "All chats" mode.
 *  Pinned-first; row click loads the chat into the thread; bottom input creates
 *  a new chat. */
export function PanelSwitcher({ sessions, loading, onSelectSession, onNewChat, onSetTotalChats }: PanelSwitcherProps) {
  const openSessionId = useChatPanelStore((s) => s.openSessionId)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null)
  const [newChatDraft, setNewChatDraft] = useState('')
  const debounceRef = useRef<number | null>(null)

  // Debounced search via FTS5
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setSearchResults(null)
      return
    }
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(async () => {
      try {
        const hits = await api.invoke<SearchHit[]>(IPC_CHANNELS.CHAT_SESSION_SEARCH, trimmed, 50)
        setSearchResults(hits)
      } catch (err) {
        console.warn('[chat-panel] switcher search failed', err)
        setSearchResults([])
      }
    }, 250)
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    }
  }, [query])

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      // Pinned first; then by lastMessageAt desc.
      if (a.isPinned !== b.isPinned) return Number(b.isPinned) - Number(a.isPinned)
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    })
  }, [sessions])

  useEffect(() => {
    if (onSetTotalChats) onSetTotalChats(sortedSessions.length)
  }, [sortedSessions.length, onSetTotalChats])

  const renderRow = (
    id: string,
    title: string,
    preview: string,
    time: string,
    pinned: boolean
  ) => (
    <button
      key={id}
      type="button"
      className={`${styles.row} ${id === openSessionId ? styles.rowActive : ''}`}
      onClick={() => onSelectSession(id)}
    >
      <div className={styles.rowTop}>
        {pinned && <span className={styles.pinIcon} aria-hidden>📌</span>}
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowTime}>{relativeTime(time)}</span>
      </div>
      {preview && <div className={styles.rowPreview}>{preview}</div>}
    </button>
  )

  return (
    <div className={styles.switcher}>
      <div className={styles.search}>
        <span className={styles.searchIcon} aria-hidden>🔍</span>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search chats and messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className={styles.list}>
        {loading && <div className={styles.empty}>Loading…</div>}

        {!loading && searchResults !== null && (
          <>
            {searchResults.length === 0 ? (
              <div className={styles.empty}>No chats match "{query.trim()}"</div>
            ) : (
              searchResults.map((hit) =>
                renderRow(
                  hit.sessionId,
                  hit.title ?? hit.snippet.replace(/<\/?mark>/g, ''),
                  hit.snippet.replace(/<\/?mark>/g, ''),
                  hit.lastMessageAt,
                  false
                )
              )
            )}
          </>
        )}

        {!loading && searchResults === null && (
          <>
            {sortedSessions.length === 0 ? (
              <div className={styles.empty}>No chats yet. Start one below.</div>
            ) : (
              sortedSessions.map((s) =>
                renderRow(
                  s.id,
                  s.title ?? 'Chat',
                  s.previewText ?? '',
                  s.lastMessageAt,
                  s.isPinned
                )
              )
            )}
          </>
        )}
      </div>

      <div className={styles.composer}>
        <div className={styles.composerInputRow}>
          <input
            className={styles.composerInput}
            type="text"
            placeholder="Start a new chat…"
            value={newChatDraft}
            onChange={(e) => setNewChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newChatDraft.trim()) {
                e.preventDefault()
                onNewChat(newChatDraft.trim())
                setNewChatDraft('')
              }
            }}
          />
          <button
            type="button"
            className={styles.composerSend}
            onClick={() => {
              onNewChat(newChatDraft.trim() || undefined)
              setNewChatDraft('')
            }}
            title="New chat"
            aria-label="New chat"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
