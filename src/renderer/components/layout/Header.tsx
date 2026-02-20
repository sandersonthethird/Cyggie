import { useLocation } from 'react-router-dom'
import styles from './Header.module.css'

const TITLES: Record<string, string> = {
  '/': 'Meetings',
  '/recording': 'Recording',
  '/templates': 'Templates',
  '/settings': 'Settings'
}

export default function Header() {
  const location = useLocation()
  const title = TITLES[location.pathname] || 'Cyggie'

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
    </header>
  )
}
