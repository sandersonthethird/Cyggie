import { NavLink } from 'react-router-dom'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import logo from '../../assets/logo.png'

export default function Sidebar() {
  const { enabled: companiesEnabled } = useFeatureFlag('ff_companies_ui_v1')

  return (
    <nav className={styles.sidebar}>
      <div className={styles.logoBlock}>
        <img src={logo} alt="Cyggie" className={styles.logoImg} />
      </div>

      <div className={styles.nav}>
        <NavLink
          to="/"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          end
        >
          <span className={styles.icon}>&#127968;</span>
          Dashboard
        </NavLink>
        <NavLink
          to="/pipeline"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#128202;</span>
          Pipeline
        </NavLink>
        {companiesEnabled && (
          <NavLink
            to="/companies"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.icon}>&#127970;</span>
            Companies
          </NavLink>
        )}
        {companiesEnabled && (
          <NavLink
            to="/contacts"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.icon}>&#128101;</span>
            Contacts
          </NavLink>
        )}
        <NavLink
          to="/meetings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9776;</span>
          Meetings
        </NavLink>
      </div>

      <div className={styles.bottom}>
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9881;</span>
          Settings
        </NavLink>
      </div>
    </nav>
  )
}
