import { useEffect, useRef, useCallback } from 'react'
import styles from './FindBar.module.css'

interface FindBarProps {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  activeMatchIndex: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export default function FindBar({
  query,
  onQueryChange,
  matchCount,
  activeMatchIndex,
  onNext,
  onPrev,
  onClose
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        onPrev()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onNext()
      }
    },
    [onClose, onNext, onPrev]
  )

  let matchInfo: React.ReactNode = null
  if (query) {
    if (matchCount === 0) {
      matchInfo = <span className={`${styles.matchInfo} ${styles.noMatches}`}>No matches</span>
    } else {
      matchInfo = (
        <span className={styles.matchInfo}>
          {activeMatchIndex + 1} of {matchCount}
        </span>
      )
    }
  }

  return (
    <div className={styles.findBarWrapper}>
      <div className={styles.findBar}>
        <input
          ref={inputRef}
          className={styles.findInput}
          type="text"
          placeholder="Find in page..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {matchInfo}
        <button
          className={styles.navBtn}
          onClick={onPrev}
          disabled={matchCount === 0}
          title="Previous match (Shift+Enter)"
        >
          &#9650;
        </button>
        <button
          className={styles.navBtn}
          onClick={onNext}
          disabled={matchCount === 0}
          title="Next match (Enter)"
        >
          &#9660;
        </button>
        <button className={styles.closeBtn} onClick={onClose} title="Close (Escape)">
          &#10005;
        </button>
      </div>
    </div>
  )
}
