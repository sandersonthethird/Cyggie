import styles from './TagSuggestionBanner.module.css'
import type { TagSuggestion } from '../../../shared/types/note'

interface TagSuggestionBannerProps {
  suggestion: TagSuggestion
  onAccept: (suggestion: TagSuggestion) => void
  onDismiss: () => void
}

export function TagSuggestionBanner({ suggestion, onAccept, onDismiss }: TagSuggestionBannerProps) {
  const label = [suggestion.companyName, suggestion.contactName]
    .filter(Boolean)
    .join(' / ')

  return (
    <div className={styles.banner}>
      <span className={styles.icon}>✨</span>
      <div className={styles.body}>
        <div className={styles.headline}>
          Tag this note to <strong>{label}</strong>?
        </div>
        {suggestion.reasoning && (
          <div className={styles.reasoning}>{suggestion.reasoning}</div>
        )}
        <div className={styles.actions}>
          <button className={styles.acceptBtn} onClick={() => onAccept(suggestion)}>
            Tag it
          </button>
          <button className={styles.dismissBtn} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
