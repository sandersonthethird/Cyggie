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
} from 'lucide-react'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { useSidebarMode } from '../../hooks/useSidebarMode'
import { Tooltip } from '../common/Tooltip'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
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
