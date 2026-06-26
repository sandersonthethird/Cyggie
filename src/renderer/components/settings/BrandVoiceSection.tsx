/**
 * Settings → Appearance → Personality. Controls the brand-voice intensity
 * (`brandVoiceIntensity`) used by empty states, loading rows, and other ambient
 * copy across the app. `off` falls back to the original neutral strings, so this
 * is also the escape hatch for anyone (or any LP demo) that wants it dialed down.
 *
 * The picker only governs ambient/low-stakes copy — destructive confirmations,
 * count-bearing failures, and security errors stay plain regardless.
 */
import { useMemo } from 'react'
import { usePreferencesStore } from '../../stores/preferences.store'
import { BRAND_VOICE_PREF_KEY, useBrandVoiceIntensity } from '../../hooks/useVoice'
import { voiceFor, type Intensity } from '@shared/voice'
import styles from './AppearanceSection.module.css'
import voiceStyles from './BrandVoiceSection.module.css'

const OPTIONS: { value: Intensity; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Plain, neutral copy everywhere.' },
  { value: 'subtle', label: 'Subtle', hint: 'A light wink here and there.' },
  { value: 'full', label: 'Full', hint: 'Bold and a little irreverent.' },
]

export function BrandVoiceSection() {
  const intensity = useBrandVoiceIntensity()
  const setJSON = usePreferencesStore((s) => s.setJSON)

  // Stable preview line per intensity so the card doesn't reshuffle on render.
  const preview = useMemo(
    () => voiceFor('emptyState', 'companies', { seed: 'settings-preview', intensity }),
    [intensity],
  )

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Personality</h2>
        <p className={styles.subtitle}>
          How much character Cyggie shows in empty states, loading messages, and
          small wins. Serious moments — deletes, failures, sign-in — always stay
          plain. Syncs to your other devices.
        </p>
      </div>

      <div className={voiceStyles.segmented} role="radiogroup" aria-label="Brand voice intensity">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={intensity === opt.value}
            className={`${voiceStyles.segment} ${intensity === opt.value ? voiceStyles.segmentActive : ''}`}
            onClick={() => setJSON(BRAND_VOICE_PREF_KEY, opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className={styles.subtitle}>{OPTIONS.find((o) => o.value === intensity)?.hint}</p>

      <div className={styles.previewLabel}>Preview</div>
      <div className={styles.previewCard}>
        <div className={voiceStyles.previewLine}>{preview}</div>
      </div>
    </div>
  )
}
