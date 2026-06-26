import styles from './EmptyState.module.css'
import { useVoiceLine } from '../../hooks/useVoice'
import type { SubKey, Variant } from '@shared/voice'

interface EmptyStateProps {
  /** Explicit title. Optional when `voiceKey` is supplied. */
  title?: string
  description?: string
  /**
   * Pull the title from the brand-voice catalog (emptyState surface) instead of
   * hardcoding it. New empty states should prefer this so they pick up the
   * brand voice — and the user's intensity setting — for free.
   */
  voiceKey?: SubKey
  /** Empty-vs-filtered context for the voiced line. */
  variant?: Variant
  action?: {
    label: string
    onClick: () => void
  }
}

export default function EmptyState({ title, description, voiceKey, variant = 'empty', action }: EmptyStateProps) {
  // Hooks must run unconditionally; ignore the result when voiceKey is absent.
  const voiced = useVoiceLine('emptyState', voiceKey ?? 'generic', variant)
  const heading = title ?? (voiceKey ? voiced : '')

  return (
    <div className={styles.container}>
      {heading && <h3 className={styles.title}>{heading}</h3>}
      {description && <p className={styles.description}>{description}</p>}
      {action && (
        <button className={styles.button} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
