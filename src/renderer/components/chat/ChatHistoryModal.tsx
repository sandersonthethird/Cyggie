import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import { useChatActions } from '../../hooks/useChatActions'
import { deriveChatContext } from '../../../shared/utils/chat-context'
import type { ChatContextKind } from '../../../shared/utils/chat-context'
import type { ChatMessage } from '../../../shared/types/meeting'
import type { ChatPageContext } from '../../../shared/types/chat'
import styles from './ChatHistoryModal.module.css'

const MARKDOWN_PLUGINS = [remarkGfm]

interface ChatSessionRow {
  id: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  previewText: string | null
  messageCount: number
  isActive: boolean
  isPinned: boolean
  isArchived: boolean
  lastMessageAt: string
}

interface PersistedMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

interface SearchResult {
  sessionId: string
  messageId: string
  contextId: string
  contextKind: ChatContextKind
  contextLabel: string | null
  title: string | null
  snippet: string
  lastMessageAt: string
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  if (day < 30) return `${Math.floor(day / 7)}w ago`
  return new Date(iso).toLocaleDateString()
}

function pageContextId(pageContext: ChatPageContext | null): string | null {
  if (!pageContext) return null
  const ctx = deriveChatContext({
    meetingId: pageContext.meetingId,
    meetingIds: pageContext.meetingIds,
    companyId: pageContext.contextOptions?.[0]?.type === 'company'
      ? pageContext.contextOptions[0].id
      : undefined,
    contactId: pageContext.contextOptions?.[0]?.type === 'contact'
      ? pageContext.contextOptions[0].id
      : undefined,
  })
  return ctx?.contextId ?? null
}

interface RowProps {
  row: ChatSessionRow
  selected?: boolean
  onClick: () => void
  onRename: (newTitle: string) => Promise<void>
  onPin: () => void
  onUnpin: () => void
  onArchive: () => void
  onDelete: () => void
}

function ChatRow({ row, selected, onClick, onRename, onPin, onUnpin, onArchive, onDelete }: RowProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(row.title ?? '')
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const badgeClass = `${styles.badge} ${styles[`badge_${row.contextKind}`]}`
  const title = row.title ?? row.previewText ?? '(Untitled chat)'
  const subtitle = `${row.messageCount} ${row.messageCount === 1 ? 'msg' : 'msgs'} • ${relativeTime(row.lastMessageAt)}`

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={() => {
        if (!renaming) onClick()
      }}
      role="button"
      tabIndex={0}
      title={new Date(row.lastMessageAt).toLocaleString()}
    >
      <span className={badgeClass}>{row.contextLabel ?? row.contextKind}</span>
      <div className={styles.rowMain}>
        {renaming ? (
          <input
            className={styles.renameInput}
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (renameValue.trim()) {
                  void onRename(renameValue.trim()).then(() => setRenaming(false))
                }
              } else if (e.key === 'Escape') {
                setRenaming(false)
                setRenameValue(row.title ?? '')
              }
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <div
            className={styles.rowTitle}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenameValue(row.title ?? '')
              setRenaming(true)
            }}
          >
            {row.isPinned ? <span className={styles.pinIcon}>📌</span> : null}
            {title}
          </div>
        )}
        <div className={styles.rowSub}>{subtitle}</div>
      </div>
      <div className={styles.rowMenuWrap} ref={menuRef}>
        <button
          className={styles.rowMenuBtn}
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          title="Actions"
        >
          ⋯
        </button>
        {menuOpen ? (
          <div className={styles.rowMenu}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                setRenameValue(row.title ?? '')
                setRenaming(true)
              }}
            >
              Rename
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                if (row.isPinned) onUnpin()
                else onPin()
              }}
            >
              {row.isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onArchive()
              }}
            >
              Archive
            </button>
            <button
              className={styles.rowMenuDanger}
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                if (window.confirm('Delete this chat? This cannot be undone.')) {
                  onDelete()
                }
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function ChatHistoryModal() {
  const modalOpen = useChatStore((s) => s.modalOpen)
  const modalConversation = useChatStore((s) => s.modalConversation)
  const closeModal = useChatStore((s) => s.closeModal)
  const loadModalSession = useChatStore((s) => s.loadModalSession)
  const appendModalMessage = useChatStore((s) => s.appendModalMessage)
  const pageContext = useChatStore((s) => s.pageContext)

  const [sessions, setSessions] = useState<ChatSessionRow[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loadingList, setLoadingList] = useState(false)
  const [threadInput, setThreadInput] = useState('')
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    setLoadingList(true)
    try {
      const rows = await api.invoke<ChatSessionRow[]>(
        IPC_CHANNELS.CHAT_SESSION_LIST_RECENT,
        { limit: 100 }
      )
      setSessions(rows)
    } catch (err) {
      console.warn('[ChatHistoryModal] list failed', err)
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    if (modalOpen && !modalConversation) {
      void refreshList()
    }
  }, [modalOpen, modalConversation, refreshList])

  // Debounced search
  useEffect(() => {
    if (!modalOpen || modalConversation) return
    const trimmed = searchQuery.trim()
    if (trimmed.length < 2) {
      setSearchResults([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(async () => {
      try {
        const results = await api.invoke<SearchResult[]>(
          IPC_CHANNELS.CHAT_SESSION_SEARCH,
          trimmed,
          50
        )
        if (!cancelled) setSearchResults(results)
      } catch (err) {
        if (!cancelled) {
          console.warn('[ChatHistoryModal] search failed', err)
          setSearchResults([])
        }
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [searchQuery, modalOpen, modalConversation])

  // Esc closes modal (but only when modal is the topmost focused thing)
  useEffect(() => {
    if (!modalOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeModal()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [modalOpen, closeModal])

  const currentPageContextId = useMemo(() => pageContextId(pageContext), [pageContext])

  const grouped = useMemo(() => {
    const pinned: ChatSessionRow[] = []
    const onPage: ChatSessionRow[] = []
    const allRecent: ChatSessionRow[] = []
    for (const s of sessions) {
      if (s.isPinned) pinned.push(s)
      else if (currentPageContextId && s.contextId === currentPageContextId) onPage.push(s)
      else allRecent.push(s)
    }
    return { pinned, onPage, allRecent }
  }, [sessions, currentPageContextId])

  const openThread = useCallback(
    async (sessionId: string, contextId: string, contextKind: ChatContextKind, contextLabel: string | null) => {
      try {
        const messages = await api.invoke<PersistedMessage[]>(
          IPC_CHANNELS.CHAT_SESSION_LOAD_MESSAGES,
          sessionId
        )
        loadModalSession(
          sessionId,
          contextId,
          contextKind,
          contextLabel,
          messages.map((m) => ({ role: m.role, content: m.content }))
        )
      } catch (err) {
        console.warn('[ChatHistoryModal] load messages failed', err)
        window.alert('This chat is no longer available.')
        void refreshList()
      }
    },
    [loadModalSession, refreshList]
  )

  const actions = useChatActions()

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        await actions.rename(sessionId, newTitle)
        await refreshList()
      } catch (err) {
        console.warn('[ChatHistoryModal] rename failed', err)
      }
    },
    [actions, refreshList]
  )

  const handlePin = useCallback(
    async (sessionId: string, pin: boolean) => {
      // Optimistic update
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, isPinned: pin } : s)))
      try {
        if (pin) await actions.pin(sessionId)
        else await actions.unpin(sessionId)
      } catch (err) {
        console.warn('[ChatHistoryModal] pin/unpin failed', err)
        // Revert
        await refreshList()
      }
    },
    [actions, refreshList]
  )

  const handleArchive = useCallback(
    async (sessionId: string) => {
      try {
        await actions.archive(sessionId)
        await refreshList()
      } catch (err) {
        console.warn('[ChatHistoryModal] archive failed', err)
      }
    },
    [actions, refreshList]
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      try {
        await actions.delete(sessionId)
        await refreshList()
      } catch (err) {
        console.warn('[ChatHistoryModal] delete failed', err)
      }
    },
    [actions, refreshList]
  )

  const handleThreadSubmit = useCallback(async () => {
    if (!modalConversation) return
    const trimmed = threadInput.trim()
    if (!trimmed) return

    setThreadInput('')
    setThreadError(null)
    setThreadLoading(true)
    appendModalMessage({ role: 'user', content: trimmed })

    try {
      let response: string
      const { contextKind, contextId } = modalConversation
      if (contextKind === 'company') {
        const companyId = contextId.startsWith('company:') ? contextId.slice('company:'.length) : contextId
        response = await api.invoke<string>(IPC_CHANNELS.COMPANY_CHAT_QUERY, {
          companyId,
          question: trimmed,
        })
      } else if (contextKind === 'contact') {
        const contactId = contextId.startsWith('contact:') ? contextId.slice('contact:'.length) : contextId
        response = await api.invoke<string>(IPC_CHANNELS.CONTACT_CHAT_QUERY, {
          contactId,
          question: trimmed,
        })
      } else if (contextKind === 'meeting') {
        response = await api.invoke<string>(IPC_CHANNELS.CHAT_QUERY_MEETING, contextId, trimmed)
      } else {
        response = await api.invoke<string>(IPC_CHANNELS.CHAT_QUERY_ALL, { question: trimmed })
      }
      appendModalMessage({ role: 'assistant', content: response })
    } catch (err) {
      console.warn('[ChatHistoryModal] thread submit failed', err)
      setThreadError(String(err))
    } finally {
      setThreadLoading(false)
    }
  }, [modalConversation, threadInput, appendModalMessage])

  if (!modalOpen) return null

  // Thread view
  if (modalConversation) {
    return (
      <div
        className={styles.backdrop}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal()
        }}
      >
        <div className={styles.modal}>
          <div className={styles.threadHeader}>
            <button
              className={styles.iconButton}
              onClick={() => {
                useChatStore.setState({ modalConversation: null })
              }}
              title="Back to list"
            >
              ←
            </button>
            <div className={styles.threadTitleWrap}>
              <span className={`${styles.badge} ${styles[`badge_${modalConversation.contextKind}`]}`}>
                {modalConversation.contextLabel ?? modalConversation.contextKind}
              </span>
              <span className={styles.threadTitle}>
                {sessions.find((s) => s.id === modalConversation.sessionId)?.title ?? 'Chat'}
              </span>
            </div>
            <button className={styles.iconButton} onClick={closeModal} title="Close">
              ✕
            </button>
          </div>
          <div className={styles.threadMessages}>
            {modalConversation.messages.map((msg, i) => (
              <div key={i} className={styles.message}>
                <span
                  className={`${styles.messageRole} ${msg.role === 'user' ? styles.messageRoleUser : styles.messageRoleAssistant}`}
                >
                  {msg.role === 'user' ? 'You' : 'AI'}
                </span>
                <div className={styles.messageContent}>
                  {msg.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{msg.content}</ReactMarkdown>
                  ) : (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                  )}
                </div>
              </div>
            ))}
            {threadLoading ? <div className={styles.threadLoading}>Thinking…</div> : null}
            {threadError ? <div className={styles.threadError}>{threadError}</div> : null}
          </div>
          <div className={styles.threadInputRow}>
            <textarea
              className={styles.threadInput}
              value={threadInput}
              onChange={(e) => setThreadInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleThreadSubmit()
                }
              }}
              placeholder="Continue this chat…"
              disabled={threadLoading}
            />
            <button
              className={styles.threadSendBtn}
              onClick={() => void handleThreadSubmit()}
              disabled={threadLoading || !threadInput.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    )
  }

  // List view
  const showingSearch = searchQuery.trim().length >= 2

  return (
    <div
      className={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal()
      }}
    >
      <div className={styles.modal}>
        <div className={styles.listHeader}>
          <h2 className={styles.listTitle}>Chat history</h2>
          <button className={styles.iconButton} onClick={closeModal} title="Close">
            ✕
          </button>
        </div>
        <input
          className={styles.searchInput}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search chats…"
        />
        <div className={styles.listBody}>
          {showingSearch ? (
            searchResults.length === 0 ? (
              <div className={styles.empty}>No chats match &ldquo;{searchQuery.trim()}&rdquo;</div>
            ) : (
              <>
                <div className={styles.sectionHeader}>Search results</div>
                {searchResults.map((r) => {
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
                      onClick={() => void openThread(r.sessionId, r.contextId, r.contextKind, r.contextLabel)}
                      onRename={(t) => handleRename(r.sessionId, t)}
                      onPin={() => void handlePin(r.sessionId, true)}
                      onUnpin={() => void handlePin(r.sessionId, false)}
                      onArchive={() => void handleArchive(r.sessionId)}
                      onDelete={() => void handleDelete(r.sessionId)}
                    />
                  )
                })}
              </>
            )
          ) : loadingList ? (
            <div className={styles.empty}>Loading…</div>
          ) : sessions.length === 0 ? (
            <div className={styles.empty}>No chats yet — start one!</div>
          ) : (
            <>
              {grouped.pinned.length > 0 ? (
                <>
                  <div className={styles.sectionHeader}>📌 Pinned</div>
                  {grouped.pinned.map((s) => (
                    <ChatRow
                      key={s.id}
                      row={s}
                      onClick={() => void openThread(s.id, s.contextId, s.contextKind, s.contextLabel)}
                      onRename={(t) => handleRename(s.id, t)}
                      onPin={() => void handlePin(s.id, true)}
                      onUnpin={() => void handlePin(s.id, false)}
                      onArchive={() => void handleArchive(s.id)}
                      onDelete={() => void handleDelete(s.id)}
                    />
                  ))}
                </>
              ) : null}
              {grouped.onPage.length > 0 ? (
                <>
                  <div className={styles.sectionHeader}>On this page</div>
                  {grouped.onPage.map((s) => (
                    <ChatRow
                      key={s.id}
                      row={s}
                      onClick={() => void openThread(s.id, s.contextId, s.contextKind, s.contextLabel)}
                      onRename={(t) => handleRename(s.id, t)}
                      onPin={() => void handlePin(s.id, true)}
                      onUnpin={() => void handlePin(s.id, false)}
                      onArchive={() => void handleArchive(s.id)}
                      onDelete={() => void handleDelete(s.id)}
                    />
                  ))}
                </>
              ) : null}
              <div className={styles.sectionHeader}>All recent</div>
              {grouped.allRecent.length === 0 ? (
                <div className={styles.empty}>No other recent chats.</div>
              ) : (
                grouped.allRecent.map((s) => (
                  <ChatRow
                    key={s.id}
                    row={s}
                    onClick={() => void openThread(s.id, s.contextId, s.contextKind, s.contextLabel)}
                    onRename={(t) => handleRename(s.id, t)}
                    onPin={() => void handlePin(s.id, true)}
                    onUnpin={() => void handlePin(s.id, false)}
                    onArchive={() => void handleArchive(s.id)}
                    onDelete={() => void handleDelete(s.id)}
                  />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
