import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
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
} from 'lucide-react'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { useAppStore } from '../../stores/app.store'
import { useSidebarMode } from '../../hooks/useSidebarMode'
import { useMiniCalendarActions } from '../../hooks/useMiniCalendarActions'
import { Tooltip } from '../common/Tooltip'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import MiniCalendar from './MiniCalendar'
import SearchBar from '../common/SearchBar'
import defaultLogo from '../../assets/logo.png'
import { api } from '../../api'

export default function Sidebar() {
  const navigate = useNavigate()
  const { mode, toggle } = useSidebarMode()
  const collapsed = mode === 'collapsed'
  const { enabled: companiesEnabled } = useFeatureFlag('ff_companies_ui_v1')
  const [brandingLogo, setBrandingLogo] = useState<string | null>(null)

  useEffect(() => {
    api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'brandingLogoDataUrl')
      .then((val) => { if (val) setBrandingLogo(val) })
      .catch(() => { /* ignore */ })
  }, [])
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const { handleRecordEvent, handlePrepareEvent, handleDismissEvent, handleClickMeeting } = useMiniCalendarActions()

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
        <SearchBar placeholder="Search" />
      </div>

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

      {calendarConnected && (
        <div className={styles.calendarSection}>
          <MiniCalendar
            calendarConnected={calendarConnected}
            dismissedEventIds={dismissedEventIds}
            storeEvents={calendarEvents}
            onRecordEvent={handleRecordEvent}
            onPrepareEvent={handlePrepareEvent}
            onDismissEvent={handleDismissEvent}
            onClickMeeting={handleClickMeeting}
          />
        </div>
      )}

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
