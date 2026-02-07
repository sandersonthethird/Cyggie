import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Header from './Header'
import styles from './Layout.module.css'

export default function Layout() {
  return (
    <div className={styles.layout}>
      <div className={styles.titlebar} />
      <div className={styles.body}>
        <Sidebar />
        <div className={styles.main}>
          <Header />
          <div className={styles.content}>
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  )
}
