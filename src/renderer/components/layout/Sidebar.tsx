import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  TrendingUp,
  Building2,
  Users,
  Calendar,
  FileText,
  CheckSquare,
  Users2,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Sparkles,
  ChevronRight,
  Pin,
} from 'lucide-react'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { useSidebarMode } from '../../hooks/useSidebarMode'
import { Tooltip } from '../common/Tooltip'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { useChatStore } from '../../stores/chat.store'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import { readAIChatsExpanded, writeAIChatsExpanded } from '../../utils/sidebar-prefs'
import SearchBar from '../common/SearchBar'
import defaultLogo from '../../assets/logo.png'
import { api } from '../../api'

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, toggle } = useSidebarMode()
  const collapsed = mode === 'collapsed'
  const { enabled: companiesEnabled } = useFeatureFlag('ff_companies_ui_v1')
  const [brandingLogo, setBrandingLogo] = useState<string | null>(null)

  // Floating search panel state (collapsed mode)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const searchIconRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'brandingLogoDataUrl')
      .then((val) => { if (val) setBrandingLogo(val) })
      .catch(() => { /* ignore */ })
  }, [])
  // Cmd+Shift+N → new note from anywhere
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        navigate('/note/new')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  // Open floating search panel — compute position once from icon rect
  const handleSearchIconClick = () => {
    if (!searchIconRef.current) return
    const rect = searchIconRef.current.getBoundingClientRect()
    setPanelPos({ top: rect.top, left: rect.right + 8 })
    setShowSearchPanel((prev) => !prev)
  }

  // Effect 1: DOM events — close panel on outside click or resize (only when open)
  useEffect(() => {
    if (!showSearchPanel) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        panelRef.current?.contains(target) ||
        searchIconRef.current?.contains(target)
      ) return
      setShowSearchPanel(false)
    }
    const handleResize = () => setShowSearchPanel(false)
    document.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [showSearchPanel])

  // Effect 2: React state — close panel when sidebar expands or route changes
  useEffect(() => {
    setShowSearchPanel(false)
  }, [collapsed, location.pathname])

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `${styles.link} ${collapsed ? styles.linkCollapsed : ''} ${isActive ? styles.active : ''}`

  /** Wrap a nav link icon + label; in collapsed mode the label fades out and a tooltip appears */
  function NavItem({ to, icon, label, end }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
    const link = (
      <NavLink to={to} className={linkClass} end={end}>
        {icon}
        <span className={styles.linkLabel}>{label}</span>
      </NavLink>
    )
    return collapsed ? <Tooltip content={label} side="right" delay={400}>{link}</Tooltip> : link
  }

  // ── AI Chats expandable nav item ────────────────────────────────
  // Persistent across navigations: localStorage key 'cyggie:sidebar:aiChatsExpanded'.
  // Defaults open if currently on /ai-chats, else closed. Refetches the recent-8
  // list on window focus + on every route change to /ai-chats (locked: 4A).
  const onAIChatsRoute = location.pathname === '/ai-chats'
  const [aiChatsExpanded, setAIChatsExpanded] = useState<boolean>(() =>
    collapsed ? false : readAIChatsExpanded(onAIChatsRoute)
  )

  useEffect(() => {
    writeAIChatsExpanded(aiChatsExpanded)
  }, [aiChatsExpanded])

  type RecentChat = {
    id: string
    title: string | null
    previewText: string | null
    isPinned: boolean
  }
  const [recentChats, setRecentChats] = useState<RecentChat[]>([])
  const panelSession = useChatStore((s) => s.panelSession)
  const modalOpen = useChatStore((s) => s.modalOpen)
  const lastActionAt = useChatPanelStore((s) => s.lastActionAt)
  const panelOpenSessionId = useChatPanelStore((s) => s.openSessionId)

  const fetchRecentChats = () => {
    api
      .invoke<Array<{
        id: string
        title: string | null
        previewText: string | null
        isPinned: boolean
      }>>(IPC_CHANNELS.CHAT_SESSION_LIST_RECENT, { limit: 8 })
      .then((rows) => {
        if (!rows) return
        // Pinned-first within the 8.
        const sorted = [...rows].sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
        setRecentChats(sorted)
      })
      .catch((err) => {
        console.warn('[Sidebar] recent chats fetch failed', err)
      })
  }

  // Fetch on mount + on focus + on route change to /ai-chats + on modal close.
  useEffect(() => {
    fetchRecentChats()
    const onFocus = () => fetchRecentChats()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (onAIChatsRoute) fetchRecentChats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const prevModalOpen = useRef(modalOpen)
  useEffect(() => {
    if (prevModalOpen.current && !modalOpen) fetchRecentChats()
    prevModalOpen.current = modalOpen
  }, [modalOpen])

  // Refetch when the chat panel reports a mutation (pin / send / rename / etc.).
  // Skips first mount so we don't double-fetch alongside the mount effect above.
  const initialActionAt = useRef(lastActionAt)
  useEffect(() => {
    if (lastActionAt === initialActionAt.current) return
    fetchRecentChats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastActionAt])

  // Force-collapse when sidebar itself collapses
  useEffect(() => {
    if (collapsed) setAIChatsExpanded(false)
  }, [collapsed])

  const openChatId =
    onAIChatsRoute ? (panelOpenSessionId ?? panelSession?.sessionId ?? null) : null

  return (
    <nav className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
      <div className={styles.searchSection}>
        {collapsed ? (
          <Tooltip content="Search" side="right" delay={400}>
            <button
              ref={searchIconRef}
              className={`${styles.searchIconBtn} ${showSearchPanel ? styles.searchIconBtnActive : ''}`}
              onClick={handleSearchIconClick}
              title="Search"
            >
              <Search size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
        ) : (
          <SearchBar placeholder="Search" />
        )}
      </div>

      {showSearchPanel && collapsed && createPortal(
        <div
          ref={panelRef}
          className={styles.searchPanel}
          style={{ top: panelPos.top, left: panelPos.left }}
        >
          <SearchBar placeholder="Search" autoFocus />
        </div>,
        document.body
      )}

      <div className={styles.nav}>
        <NavItem to="/" icon={<LayoutDashboard size={16} strokeWidth={1.5} />} label="Dashboard" end />
        <NavItem to="/pipeline" icon={<TrendingUp size={16} strokeWidth={1.5} />} label="Pipeline" />
        {companiesEnabled && (
          <NavItem to="/companies" icon={<Building2 size={16} strokeWidth={1.5} />} label="Companies" />
        )}
        {companiesEnabled && (
          <NavItem to="/contacts" icon={<Users size={16} strokeWidth={1.5} />} label="Contacts" />
        )}
        <NavItem to="/meetings" icon={<Calendar size={16} strokeWidth={1.5} />} label="Meetings" />
        <NavItem to="/notes" icon={<FileText size={16} strokeWidth={1.5} />} label="Notes" />
        <NavItem to="/tasks" icon={<CheckSquare size={16} strokeWidth={1.5} />} label="Tasks" />
        <NavItem to="/partner-meeting" icon={<Users2 size={16} strokeWidth={1.5} />} label="Partner Sync" />

        {/* AI Chats — expandable, with up to 8 recent chats nested below */}
        {collapsed ? (
          <NavItem to="/ai-chats" icon={<Sparkles size={16} strokeWidth={1.5} />} label="AI Chats" />
        ) : (
          <div className={styles.aiChatsBlock}>
            <div className={styles.aiChatsHeader}>
              <NavLink to="/ai-chats" className={linkClass} style={{ flex: 1 }}>
                <Sparkles size={16} strokeWidth={1.5} />
                <span className={styles.linkLabel}>AI Chats</span>
              </NavLink>
              <button
                className={styles.aiChatsCaret}
                onClick={() => setAIChatsExpanded((v) => !v)}
                aria-expanded={aiChatsExpanded}
                aria-label={aiChatsExpanded ? 'Collapse AI Chats' : 'Expand AI Chats'}
                title={aiChatsExpanded ? 'Collapse' : 'Expand'}
              >
                <ChevronRight
                  size={13}
                  className={`${styles.aiChatsCaretIcon} ${aiChatsExpanded ? styles.aiChatsCaretIconOpen : ''}`}
                />
              </button>
            </div>
            {aiChatsExpanded && (
              <div className={styles.aiChatsRecent}>
                {recentChats.length === 0 ? (
                  <div className={styles.aiChatsEmpty}>No chats yet</div>
                ) : (
                  recentChats.map((c) => {
                    const isOpen = openChatId === c.id
                    const itemClass = `${styles.aiChatsRecentItem} ${isOpen ? styles.aiChatsRecentItemOpen : ''}`
                    const label = c.title ?? c.previewText ?? '(Untitled chat)'
                    return (
                      <button
                        key={c.id}
                        className={itemClass}
                        onClick={() => navigate(`/ai-chats?openChat=${c.id}`)}
                        title={label}
                      >
                        {c.isPinned && (
                          <Pin size={9} className={styles.aiChatsPin} aria-label="Pinned" />
                        )}
                        <span className={styles.aiChatsRecentLabel}>{label}</span>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.bottom}>
        <div className={styles.logoBlock}>
          <img src={brandingLogo ?? defaultLogo} alt="Logo" className={styles.logoImg} />
        </div>
        <button className={styles.toggleBtn} onClick={toggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed
            ? <ChevronsRight size={14} strokeWidth={1.6} />
            : <><ChevronsLeft size={14} strokeWidth={1.6} /><span className={styles.linkLabel}>Collapse</span></>
          }
        </button>
        <NavItem to="/settings" icon={<Settings size={16} strokeWidth={1.5} />} label="Settings" />
      </div>
    </nav>
  )
}
