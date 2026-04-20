import { useMemo } from 'react'
import type { TakeawaysState } from './KeyTakeawaysCard.types'
import styles from './KeyTakeawaysCard.module.css'

// Re-export the state type so consumers only need one import
export type { TakeawaysState }

interface KeyTakeawaysCardProps {
  kt: TakeawaysState
  /** Optional footer text (e.g. "Generated 2h ago from 4 meetings + 18 emails") */
  footerText?: string
}

/**
 * AI-generated Key Takeaways card with brand-red accent.
 * Presentational component — all state comes from the `useTakeaways` hook.
 */
export function KeyTakeawaysCard({ kt, footerText }: KeyTakeawaysCardProps) {
  const bullets = useMemo(() => {
    if (!kt.text) return []
    return kt.text
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean)
  }, [kt.text])

  // Generate button — shown when no takeaways exist
  if (kt.showGenerate) {
    return (
      <button className={styles.generateBtn} onClick={kt.generate} disabled={kt.generating}>
        ✦ Generate Key Takeaways
      </button>
    )
  }

  // Streaming state — show raw text as it arrives
  if (kt.generating && kt.streaming) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>✦ KEY TAKEAWAYS</span>
        </div>
        <div className={styles.streamingText}>{kt.streaming}</div>
      </div>
    )
  }

  // Loading state (generating but no streaming text yet)
  if (kt.generating) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>✦ KEY TAKEAWAYS</span>
        </div>
        <div className={styles.streamingText}>Generating…</div>
      </div>
    )
  }

  // Error state
  if (kt.error && !kt.text) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>✦ KEY TAKEAWAYS</span>
        </div>
        <div className={styles.error}>{kt.error}</div>
        <button className={styles.generateBtn} onClick={kt.generate}>
          Try again
        </button>
      </div>
    )
  }

  // Edit mode
  if (kt.editing) {
    return (
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.label}>✦ KEY TAKEAWAYS</span>
        </div>
        <textarea
          ref={kt.textareaRef}
          className={styles.editArea}
          defaultValue={kt.text}
          autoFocus
        />
        <div className={styles.editActions}>
          <button className={styles.cancelBtn} onClick={kt.cancelEditing}>Cancel</button>
          <button className={styles.saveBtn} onClick={kt.save}>Save</button>
        </div>
      </div>
    )
  }

  // Display mode — show bullets
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.label}>✦ KEY TAKEAWAYS</span>
        <div className={styles.headerActions}>
          <button className={styles.editBtn} onClick={kt.startEditing}>Edit</button>
          <button className={styles.updateBtn} onClick={kt.generate}>
            {kt.hasNewData && <span className={styles.staleDot} />}
            ✨ Update
          </button>
        </div>
      </div>

      <ul className={styles.bullets}>
        {bullets.map((bullet, i) => (
          <li key={i} className={styles.bullet}>
            <span className={styles.bulletDot} />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      {kt.error && <div className={styles.error}>{kt.error}</div>}

      {footerText && <div className={styles.footer}>{footerText}</div>}
    </div>
  )
}
