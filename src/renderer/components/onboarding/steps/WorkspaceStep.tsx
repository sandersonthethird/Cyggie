import { slugify } from '../onboarding-logic'
import { StepLinks } from '../StepLinks'
import styles from '../Onboarding.module.css'

/**
 * Step 1 — name the workspace. The URL slug auto-derives from the firm name
 * until the user edits the slug directly (then it sticks).
 */
export function WorkspaceStep({
  firmName,
  slug,
  slugEdited,
  onFirmName,
  onSlug,
  onBack,
  onNext,
}: {
  firmName: string
  slug: string
  slugEdited: boolean
  onFirmName: (name: string, derivedSlug: string | null) => void
  onSlug: (slug: string) => void
  onBack: () => void
  onNext: () => void
}) {
  const handleName = (value: string): void => {
    // Pass the auto-derived slug only while the user hasn't hand-edited it.
    onFirmName(value, slugEdited ? null : slugify(value))
  }

  return (
    <div className={styles.card}>
      <div className={styles.headBlock}>
        <h1 className={styles.heading}>Name your workspace</h1>
        <p className={styles.sub}>This is how your firm shows up across Cyggie.</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ob-firm">Firm name</label>
        <input
          id="ob-firm"
          className={styles.input}
          value={firmName}
          autoFocus
          placeholder="Red Swan Ventures"
          onChange={(e) => handleName(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="ob-slug">Workspace URL</label>
        <input
          id="ob-slug"
          className={`${styles.input} ${styles.inputMono}`}
          value={slug}
          placeholder="red-swan-ventures"
          onChange={(e) => onSlug(slugify(e.target.value))}
        />
        <span className={styles.hint}>Lowercase letters, numbers, and hyphens.</span>
      </div>

      <button
        type="button"
        className={styles.primaryBtn}
        disabled={!firmName.trim() || !slug.trim()}
        onClick={onNext}
      >
        Continue
      </button>
      <StepLinks onBack={onBack} />
    </div>
  )
}
