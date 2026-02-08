import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import SearchBar from '../common/SearchBar'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Layout.module.css'

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const showSearch = location.pathname === '/'

  const handleCreateNote = async () => {
    try {
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to create note:', err)
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.titlebar}>
        {showSearch && (
          <div className={styles.titlebarControls}>
            <div className={styles.titlebarSearch}>
              <SearchBar />
            </div>
            <button className={styles.titlebarNewNote} onClick={handleCreateNote}>
              + New Note
            </button>
          </div>
        )}
      </div>
      <div className={styles.body}>
        <Sidebar />
        <div className={styles.main}>
          <div className={styles.content}>
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  )
}
