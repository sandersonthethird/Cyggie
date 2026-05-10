import type { ReactNode, MouseEvent } from 'react'
import styles from './Pill.module.css'

export type PillTone = 'green' | 'violet' | 'amber' | 'sky' | 'rose' | 'neutral'

interface PillProps {
  tone?: PillTone
  dot?: boolean
  avatar?: { initial: string; bg?: string }
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  className?: string
  children: ReactNode
}

export function Pill({ tone = 'neutral', dot, avatar, onClick, className, children }: PillProps) {
  const cls = [styles.pill, styles[`tone-${tone}`], className].filter(Boolean).join(' ')
  const interactive = typeof onClick === 'function'
  return (
    <span
      className={cls}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick!(e as unknown as MouseEvent<HTMLSpanElement>) } : undefined}
    >
      {avatar && (
        <span
          className={styles.avatar}
          style={avatar.bg ? { background: avatar.bg } : undefined}
          aria-hidden
        >
          {avatar.initial}
        </span>
      )}
      {dot && !avatar && <span className={styles.dot} aria-hidden />}
      <span className={styles.label}>{children}</span>
    </span>
  )
}
