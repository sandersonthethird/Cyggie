import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import Sidebar from './Sidebar'
import CommandPalette from '../common/CommandPalette'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Layout.module.css'

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const showMeetingPage = location.pathname === '/meetings'
  const showCompanySearch = location.pathname === '/companies'
  const showContactSearch = location.pathname === '/contacts'
  const showEntitySearch = showCompanySearch || showContactSearch
  const showEntityNew = searchParams.get('new') === '1'
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const handleCreateNote = async () => {
    try {
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to create note:', err)
    }
  }

  const handleEntityNewToggle = () => {
    const next = new URLSearchParams(searchParams)
    if (showEntityNew) {
      next.delete('new')
    } else {
      next.set('new', '1')
    }
    setSearchParams(next)
  }

  return (
    <div className={styles.layout}>
      <div className={styles.titlebar}>
        {showMeetingPage && (
          <div className={styles.titlebarControls}>
            <button className={styles.titlebarNewNote} onClick={handleCreateNote}>
              + New Note
            </button>
          </div>
        )}
        {showEntitySearch && (
          <div className={styles.titlebarEntityControls}>
            <button className={styles.titlebarEntityNewBtn} onClick={handleEntityNewToggle}>
              {showEntityNew ? 'Cancel' : (showCompanySearch ? '+ New Company' : '+ New Contact')}
            </button>
          </div>
        )}
        {!showMeetingPage && !showEntitySearch && <div className={styles.titlebarSpacer} />}
        <button className={styles.askButton} onClick={() => setPaletteOpen(true)}>
          Ask (Cmd+K)
        </button>
      </div>
      <div className={styles.body}>
        <Sidebar />
        <div className={styles.main}>
          <div className={styles.content}>
            <Outlet />
          </div>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
