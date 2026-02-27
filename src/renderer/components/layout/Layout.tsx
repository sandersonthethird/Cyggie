import { useEffect } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import Sidebar from './Sidebar'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Layout.module.css'

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const showMeetingPage = location.pathname === '/meetings'
  const showCompanySearch = location.pathname === '/companies'
  const showContactSearch = location.pathname === '/contacts'
  const showEntitySearch = showCompanySearch || showContactSearch
  const showEntityNew = searchParams.get('new') === '1'

  useEffect(() => {
    const focusChatInput = (): boolean => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-chat-shortcut="true"]')
      ).filter((el) => !el.disabled && el.offsetParent !== null)

      if (candidates.length === 0) return false
      const target = candidates[candidates.length - 1]
      target.focus()
      if ('selectionStart' in target && 'value' in target) {
        const end = target.value.length
        target.setSelectionRange(end, end)
      }
      return true
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (focusChatInput()) {
          event.preventDefault()
        }
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
    if (!showEntitySearch) return
    const next = new URLSearchParams(searchParams)
    if (showEntityNew) {
      next.delete('new')
    } else {
      next.set('new', '1')
    }
    const targetPath = showCompanySearch ? '/companies' : '/contacts'
    const query = next.toString()
    navigate(query ? `${targetPath}?${query}` : targetPath)
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
