import { useEffect, useState } from 'react'
import styles from './NowLine.module.css'

function formatNowTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function NowLine() {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.line} />
      <span className={styles.label}>NOW · {formatNowTime(now)}</span>
      <div className={styles.dot} />
    </div>
  )
}
