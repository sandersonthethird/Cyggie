/**
 * Settings → Appearance. Canonical home for reading-density preferences
 * (line spacing, text size, line width). Always accessible — unlike the
 * TiptapBubbleMenu "Aa" shortcut, which needs a text selection.
 *
 * Reads/writes the synced pref via useAppearancePref (shared source of truth
 * with the bubble). The live preview reflects the user's *unsaved-but-applied*
 * choice immediately because the tokens are already on document.documentElement
 * — the preview text simply composes the shared tiptap reading styles.
 */
import { useAppearancePref } from '../../hooks/useAppearance'
import { DEFAULTS } from '../../lib/appearance'
import { AppearanceControls } from '../common/AppearanceControls'
import styles from './AppearanceSection.module.css'

export function AppearanceSection() {
  const [appearance, setAppearance] = useAppearancePref()
  const isDefault =
    appearance.lineSpacing === DEFAULTS.lineSpacing &&
    appearance.fontSize === DEFAULTS.fontSize &&
    appearance.lineWidth === DEFAULTS.lineWidth

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Reading & display</h2>
        <p className={styles.subtitle}>
          Adjust how notes, meeting summaries, and other long-form text are
          displayed. Applies everywhere in Cyggie and syncs to your other
          devices.
        </p>
      </div>

      <AppearanceControls value={appearance} onChange={setAppearance} tone="light" />

      <button
        type="button"
        className={styles.reset}
        disabled={isDefault}
        onClick={() => setAppearance(DEFAULTS)}
      >
        Reset to defaults
      </button>

      <div className={styles.previewLabel}>Preview</div>
      <div className={styles.previewCard}>
        {/* tiptapContent makes the preview pick up the same reading tokens as
            the real editors, so it reflects the live setting exactly. */}
        <div className={styles.preview}>
          <div className="ProseMirror">
            <h3>Weekly partner sync</h3>
            <p>
              Discussed the Q3 pipeline and the two new inbound intros. The team
              agreed to prioritize the enterprise deal and revisit pricing next
              week.
            </p>
            <p>
              Action items were captured below — owners to confirm by Friday so
              we can lock the agenda for the board update.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
