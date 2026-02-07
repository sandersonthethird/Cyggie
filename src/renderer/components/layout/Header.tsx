import { useLocation, useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import SearchBar from '../common/SearchBar'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Header.module.css'

const TITLES: Record<string, string> = {
  '/': 'Meetings',
  '/query': 'Query',
  '/recording': 'Recording',
  '/templates': 'Templates',
  '/settings': 'Settings'
}

export default function Header() {
  const location = useLocation()
  const navigate = useNavigate()
  const title = TITLES[location.pathname] || 'GORP'
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
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      {showSearch && (
        <>
          <div className={styles.search}>
            <SearchBar />
          </div>
          <button className={styles.newNoteBtn} onClick={handleCreateNote}>
            + New Note
          </button>
        </>
      )}
    </header>
  )
}
