import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Layout.module.css'

export default function Layout() {
  const navigate = useNavigate()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!newMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [newMenuOpen])

  const handleNewNote = async () => {
    setNewMenuOpen(false)
    try {
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to create note:', err)
    }
  }

  const handleNewCompany = () => {
    setNewMenuOpen(false)
    navigate('/companies?new=1')
  }

  const handleNewContact = () => {
    setNewMenuOpen(false)
    navigate('/contacts?new=1')
  }

  const handleNewTask = () => {
    setNewMenuOpen(false)
    navigate('/tasks')
  }

  return (
    <div className={styles.layout}>
      <div className={styles.titlebar}>
        <div className={styles.titlebarControls}>
          <div className={styles.titlebarNewDropdown} ref={newMenuRef}>
            <button
              className={styles.titlebarNewBtn}
              onClick={() => setNewMenuOpen((v) => !v)}
            >
              + New
            </button>
            {newMenuOpen && (
              <div className={styles.titlebarNewMenu}>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewNote}>
                  Note
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewCompany}>
                  Company
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewContact}>
                  Contact
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewTask}>
                  Task
                </button>
              </div>
            )}
          </div>
        </div>
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
